"""Builds `docker run` argument vectors. Pure functions: easy to assert on in tests.

Hardening applied to EVERY untrusted container:
  * non-root numeric user, all capabilities dropped, no-new-privileges
  * default seccomp profile (never `unconfined`), never `--privileged`
  * memory / swap / cpu / pids limits, `--ulimit nofile/nproc/fsize`
  * read-only root filesystem for runtimes; tmpfs scratch with noexec,nosuid
  * no Docker socket, no host mounts other than the dedicated workspace / app directory
  * `--network none` for steps that need no network; otherwise a firewalled egress network
  * no `--pid=host`, `--ipc=host`, `--uts=host`, devices, or extra mounts
"""

from __future__ import annotations

from dataclasses import dataclass

from .settings import Settings


@dataclass(frozen=True)
class Limits:
    memory_mb: int
    cpus: float
    pids: int


def _hardening(s: Settings, lim: Limits) -> list[str]:
    return [
        "--user", f"{s.run_uid}:{s.run_uid}",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--memory", f"{lim.memory_mb}m",
        "--memory-swap", f"{lim.memory_mb}m",
        "--cpus", f"{lim.cpus:g}",
        "--pids-limit", str(lim.pids),
        "--ulimit", "nofile=4096:4096",
        "--ulimit", f"nproc={lim.pids}:{lim.pids}",
        "--ulimit", "fsize=2147483648:2147483648",
        "--ipc", "private",
        "--init",
    ]


def _env_args(env: dict[str, str]) -> list[str]:
    # `-e KEY` (no value) makes docker read the value from the *docker CLI process environment*,
    # so secrets never appear in argv / `ps` output / `docker inspect` of the command line.
    out: list[str] = []
    for k in env:
        out += ["-e", k]
    return out


def step_args(
    s: Settings,
    *,
    name: str,
    image: str,
    workspace_host_dir: str,
    workdir: str,
    command: list[str],
    env: dict[str, str],
    network: str,
    limits: Limits,
) -> list[str]:
    net = "none" if network == "none" else s.egress_network
    return [
        s.docker_bin, "run", "--rm", "--name", name,
        *_hardening(s, limits),
        "--network", net,
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
        "-v", f"{workspace_host_dir}:/workspace:rw",
        "-w", workdir,
        "-e", "HOME=/workspace/.home",
        "-e", "CI=true",
        "-e", "npm_config_update_notifier=false",
        "-e", "PIP_DISABLE_PIP_VERSION_CHECK=1",
        *_env_args(env),
        "--entrypoint", command[0],
        image, *command[1:],
    ]


def runtime_args(
    s: Settings,
    *,
    name: str,
    image: str,
    app_host_dir: str,
    command: list[str],
    env: dict[str, str],
    port: int,
    limits: Limits,
    labels: dict[str, str],
) -> list[str]:
    args = [
        s.docker_bin, "run", "-d", "--name", name,
        *_hardening(s, limits),
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
        "--restart", "no",
        "--stop-timeout", "15",
        "--network", s.runtime_network,
        "-v", f"{app_host_dir}:/app:ro",
        "-w", "/app/src",
        "-e", f"PORT={port}",
        "-e", "HOME=/tmp",
        "-e", "PYTHONDONTWRITEBYTECODE=1",
        "-e", "PYTHONUNBUFFERED=1",
        "-e", "PYTHONPATH=/app/deps",
        "-e", "PATH=/app/deps/bin:/usr/local/bin:/usr/bin:/bin",
        *_env_args(env),
    ]
    for k, v in labels.items():
        args += ["--label", f"{k}={v}"]
    args += ["--entrypoint", command[0], image, *command[1:]]
    return args


def shell(command: str) -> list[str]:
    """User commands run through `sh -c` INSIDE the sandbox container (never on the host)."""
    return ["sh", "-c", command]
