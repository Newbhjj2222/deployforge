"""Agent configuration (environment only; no files, no defaults that weaken isolation)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


# Toolchain keys are the ONLY way a caller can pick an image. Callers never send image names.
DEFAULT_TOOLCHAINS: dict[str, str] = {
    "git": "alpine/git:2.45.2",
    "node-20": "node:20-bookworm-slim",
    "node-22": "node:22-bookworm-slim",
    "python-3.10": "python:3.10-slim-bookworm",
    "python-3.11": "python:3.11-slim-bookworm",
    "python-3.12": "python:3.12-slim-bookworm",
    "python-3.13": "python:3.13-slim-bookworm",
}


@dataclass(frozen=True)
class Settings:
    token: str
    workspace_root: str  # path of workspaces INSIDE this process
    workspace_host_root: str  # same directory as seen by the Docker daemon (bind-mount source)
    runtime_root: str
    runtime_host_root: str
    bundle_root: str
    dev_git_root: str | None
    dev_git_host_root: str | None
    egress_network: str  # network with internet access but firewalled from internal ranges
    runtime_network: str  # internal network shared with the edge; no route to the internet by default
    runtime_egress: bool
    max_memory_mb: int
    max_cpus: float
    max_pids: int
    max_timeout_seconds: int
    max_log_line: int
    max_log_lines_per_step: int
    run_uid: int
    toolchains: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_TOOLCHAINS))
    docker_bin: str = "docker"

    @staticmethod
    def from_env() -> Settings:
        token = os.environ.get("SANDBOX_AGENT_TOKEN", "")
        if len(token) < 16:
            raise RuntimeError("SANDBOX_AGENT_TOKEN must be set to a random value of at least 16 characters")
        ws = os.environ.get("WORKSPACE_ROOT", "/var/lib/deployforge/workspaces")
        rt = os.environ.get("RUNTIME_ROOT", "/var/lib/deployforge/runtimes")
        return Settings(
            token=token,
            workspace_root=ws,
            workspace_host_root=os.environ.get("WORKSPACE_HOST_ROOT", ws),
            runtime_root=rt,
            runtime_host_root=os.environ.get("RUNTIME_HOST_ROOT", rt),
            bundle_root=os.environ.get("BUNDLE_ROOT", "/var/lib/deployforge/bundles"),
            dev_git_root=os.environ.get("DEV_LOCAL_GIT_ROOT") or None,
            dev_git_host_root=os.environ.get("DEV_LOCAL_GIT_HOST_ROOT") or os.environ.get("DEV_LOCAL_GIT_ROOT") or None,
            egress_network=os.environ.get("BUILD_EGRESS_NETWORK", "deployforge-build-egress"),
            runtime_network=os.environ.get("RUNTIME_NETWORK", "deployforge-runtime"),
            runtime_egress=os.environ.get("RUNTIME_EGRESS", "false").lower() == "true",
            max_memory_mb=_int("MAX_MEMORY_MB", 4096),
            max_cpus=float(os.environ.get("MAX_CPUS", "4")),
            max_pids=_int("MAX_PIDS", 1024),
            max_timeout_seconds=_int("MAX_STEP_TIMEOUT_SECONDS", 1800),
            max_log_line=_int("MAX_LOG_LINE", 4000),
            max_log_lines_per_step=_int("MAX_LOG_LINES_PER_STEP", 50_000),
            run_uid=_int("SANDBOX_UID", 10001),
        )
