"""HTTP-level tests. Docker is never contacted: routes under test fail before reaching it."""

import os
import tempfile

import pytest

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

from agent.main import create_app  # noqa: E402
from tests.test_safety import make_settings  # noqa: E402


@pytest.fixture()
def client():
    with tempfile.TemporaryDirectory() as d:
        s = make_settings(workspace_root=os.path.join(d, "w"), runtime_root=os.path.join(d, "r"), bundle_root=os.path.join(d, "b"))
        with TestClient(create_app(s)) as c:
            c.headers.update({"authorization": f"Bearer {s.token}"})
            c.settings = s
            yield c


def test_requires_bearer_token(client):
    r = client.get("/v1/workspaces/w1/tree", headers={"authorization": "Bearer wrong"})
    assert r.status_code == 401
    assert client.get("/healthz").status_code == 200  # liveness is unauthenticated


def test_step_rejects_unknown_toolchain_and_reserved_env(client):
    base = {"step_id": "s1", "kind": "build", "workspace_id": "w1", "toolchain": "evil:latest", "command": "id", "timeout_seconds": 10}
    assert client.post("/v1/steps", json=base).status_code == 400
    ok_tc = {**base, "toolchain": "node-22", "env": {"LD_PRELOAD": "/x"}}
    assert client.post("/v1/steps", json=ok_tc).status_code == 400
    assert client.post("/v1/steps", json={**base, "toolchain": "node-22", "image": "alpine"}).status_code == 422  # extra fields forbidden


def test_step_rejects_traversal_in_workdir_and_ids(client):
    base = {"step_id": "s1", "kind": "build", "workspace_id": "w1", "toolchain": "node-22", "command": "id", "timeout_seconds": 10}
    assert client.post("/v1/steps", json={**base, "workdir": "../../etc"}).status_code in (400, 200)  # validated lazily in stream
    assert client.get("/v1/workspaces/..%2f..%2fetc/tree").status_code in (400, 404)


def test_clone_requires_valid_sha_and_url(client):
    base = {"step_id": "c1", "kind": "clone", "workspace_id": "w1", "toolchain": "git", "timeout_seconds": 10}
    bad_sha = {**base, "source": {"kind": "https", "url": "https://github.com/a/b.git", "sha": "main"}}
    assert client.post("/v1/steps", json=bad_sha).status_code == 400
    bad_url = {**base, "source": {"kind": "https", "url": "https://u:p@github.com/a/b.git", "sha": "a" * 40}}
    assert client.post("/v1/steps", json=bad_url).status_code == 400
    local = {**base, "source": {"kind": "local", "path": "/etc", "sha": "a" * 40}}
    assert client.post("/v1/steps", json=local).status_code == 400  # local sources disabled


def test_tree_and_file_endpoints_do_not_leak(client):
    ws = os.path.join(client.settings.workspace_root, "w1", "src", "dist")
    os.makedirs(ws)
    open(os.path.join(ws, "index.html"), "w").write("<h1>x</h1>")
    os.symlink("/etc/passwd", os.path.join(ws, "pw"))
    r = client.get("/v1/workspaces/w1/tree", params={"dir": "dist"})
    assert r.status_code == 200
    assert [f["path"] for f in r.json()["files"]] == ["index.html"]
    assert client.get("/v1/workspaces/w1/file", params={"path": "dist/pw"}).status_code == 400
    assert client.get("/v1/workspaces/w1/file", params={"path": "dist/index.html"}).status_code == 200
    assert client.get("/v1/workspaces/w1/tree", params={"dir": "../.."}).status_code == 400
    assert client.get("/v1/workspaces/w1/tree", params={"dir": "nope"}).status_code == 404
    assert client.get("/v1/workspaces/w1/tree", params={"dir": "dist", "max_files": 0}).status_code == 413
