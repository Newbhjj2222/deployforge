import os
import tempfile

import pytest

from agent import safety
from agent.dockerargs import Limits, runtime_args, step_args
from agent.settings import Settings


def make_settings(**kw) -> Settings:
    base = dict(
        token="x" * 20, workspace_root="/w", workspace_host_root="/hw", runtime_root="/r", runtime_host_root="/hr",
        bundle_root="/b", dev_git_root=None, dev_git_host_root=None, egress_network="egress", runtime_network="rt", runtime_egress=False,
        max_memory_mb=4096, max_cpus=4, max_pids=1024, max_timeout_seconds=1800, max_log_line=4000,
        max_log_lines_per_step=1000, run_uid=10001,
    )
    base.update(kw)
    return Settings(**base)


@pytest.mark.parametrize("bad", ["../x", "/etc", "a/../b", "a//b", "a\x00b", ".."])
def test_rel_dir_rejects(bad):
    with pytest.raises(safety.UnsafeInput):
        safety.check_rel_dir(bad)


def test_rel_dir_accepts():
    assert safety.check_rel_dir("./dist/") == "dist"
    assert safety.check_rel_dir("") == ""
    assert safety.check_rel_dir("apps/web") == "apps/web"


@pytest.mark.parametrize("key", ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "DOCKER_HOST", "SANDBOX_AGENT_TOKEN", "1BAD", "A-B"])
def test_env_rejects_dangerous_names(key):
    with pytest.raises(safety.UnsafeInput):
        safety.check_env({key: "v"})


def test_env_accepts_normal():
    assert safety.check_env({"API_URL": "https://x"}) == {"API_URL": "https://x"}


@pytest.mark.parametrize("url", ["http://github.com/a/b.git", "https://user:pw@github.com/a/b.git", "https://github.com/a/../b.git", "file:///etc", "https://github.com/a/b"])
def test_clone_url_rejects(url):
    with pytest.raises(safety.UnsafeInput):
        safety.check_clone_url(url)


def test_clone_url_accepts():
    assert safety.check_clone_url("https://github.com/octo/hello.git")


def test_sha():
    safety.check_sha("a" * 40)
    for bad in ("main", "A" * 40, "a" * 39, "a" * 40 + "; rm -rf /"):
        with pytest.raises(safety.UnsafeInput):
            safety.check_sha(bad)


def test_local_source_is_confined():
    with tempfile.TemporaryDirectory() as root:
        os.mkdir(os.path.join(root, "repo"))
        assert safety.check_local_source(os.path.join(root, "repo"), root)
        with pytest.raises(safety.UnsafeInput):
            safety.check_local_source("/etc", root)
        with pytest.raises(safety.UnsafeInput):
            safety.check_local_source(os.path.join(root, "repo"), None)


def test_walk_tree_skips_symlinks_hidden_and_enforces_limits():
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "assets"))
        open(os.path.join(d, "index.html"), "w").write("hi")
        open(os.path.join(d, "assets", "a.js"), "w").write("x" * 10)
        open(os.path.join(d, ".env"), "w").write("SECRET=1")
        os.makedirs(os.path.join(d, ".well-known"))
        open(os.path.join(d, ".well-known", "x"), "w").write("ok")
        os.symlink("/etc/passwd", os.path.join(d, "leak.txt"))
        os.symlink("/etc", os.path.join(d, "etcdir"))
        files, total, skipped = safety.walk_tree(d, max_files=10, max_bytes=1000, max_file_bytes=100)
        assert [f.path for f in files] == [".well-known/x", "assets/a.js", "index.html"]
        assert total == 14
        assert {".env", "leak.txt", "etcdir"} <= set(skipped)
        with pytest.raises(safety.TreeLimitExceeded):
            safety.walk_tree(d, max_files=1, max_bytes=1000, max_file_bytes=100)
        with pytest.raises(safety.TreeLimitExceeded):
            safety.walk_tree(d, max_files=10, max_bytes=5, max_file_bytes=100)
        with pytest.raises(safety.TreeLimitExceeded):
            safety.walk_tree(d, max_files=10, max_bytes=1000, max_file_bytes=5)


def test_open_regular_file_refuses_symlinks_hidden_and_traversal():
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, "a.txt"), "w").write("a")
        os.symlink("/etc/passwd", os.path.join(d, "link"))
        open(os.path.join(d, ".env"), "w").write("s")
        assert safety.open_regular_file(d, "a.txt").endswith("a.txt")
        for bad in ("link", ".env", "../x", "missing", "/etc/passwd"):
            with pytest.raises(safety.UnsafeInput):
                safety.open_regular_file(d, bad)


def test_step_container_is_hardened():
    s = make_settings()
    argv = step_args(
        s, name="df-step-1", image="node:22", workspace_host_dir="/hw/w1", workdir="/workspace/src",
        command=["sh", "-c", "npm ci"], env={"TOKEN": "secret"}, network="none", limits=Limits(1024, 1, 256),
    )
    joined = " ".join(argv)
    assert "--privileged" not in argv
    assert "docker.sock" not in joined
    assert ["--cap-drop", "ALL"] == argv[argv.index("--cap-drop"): argv.index("--cap-drop") + 2]
    assert "no-new-privileges:true" in argv
    assert argv[argv.index("--network") + 1] == "none"
    assert argv[argv.index("--user") + 1] == "10001:10001"
    assert "--pids-limit" in argv and "--memory" in argv
    assert "secret" not in joined, "secret values must never appear in argv"
    assert "-e" in argv and "TOKEN" in argv
    mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "-v"]
    assert mounts == ["/hw/w1:/workspace:rw"]


def test_egress_step_uses_firewalled_network():
    s = make_settings()
    argv = step_args(s, name="n", image="i", workspace_host_dir="/hw/w", workdir="/workspace", command=["sh", "-c", "x"], env={}, network="egress", limits=Limits(512, 1, 64))
    assert argv[argv.index("--network") + 1] == "egress"


def test_runtime_container_is_hardened():
    s = make_settings()
    argv = runtime_args(
        s, name="df-rt-1", image="python:3.12", app_host_dir="/hr/d1", command=["sh", "-c", "exec uvicorn main:app"],
        env={"DB_PASSWORD": "pw"}, port=8000, limits=Limits(512, 0.5, 256), labels={"a": "b"},
    )
    assert "--read-only" in argv and "--privileged" not in argv
    assert argv[argv.index("--network") + 1] == "rt"
    assert "/hr/d1:/app:ro" in argv
    assert "pw" not in " ".join(argv)
    assert "--restart" in argv and argv[argv.index("--restart") + 1] == "no"


def test_clamp():
    assert safety.clamp(None, 2, 4) == 2
    assert safety.clamp(100, 2, 4) == 4
    assert safety.clamp(-1, 2, 4) == 2
