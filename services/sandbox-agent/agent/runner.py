"""Executes steps and runtimes through the Docker CLI (argv lists only, never shell=True)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import time
import urllib.request
from collections.abc import AsyncIterator

from . import dockerargs, safety
from .models import RuntimeInfo, RuntimeRequest, StepRequest
from .settings import Settings

CLONE_SCRIPT = r"""
set -eu
rm -rf /workspace/src
git init -q /workspace/src
cd /workspace/src
git remote add origin "$DF_CLONE_URL"
if [ -n "${DF_GIT_TOKEN:-}" ]; then
  AUTH=$(printf 'x-access-token:%s' "$DF_GIT_TOKEN" | base64 | tr -d '\n')
  git -c "http.extraHeader=Authorization: Basic $AUTH" fetch --depth 1 -q origin "$DF_SHA"
else
  git fetch --depth 1 -q origin "$DF_SHA"
fi
git checkout -q --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$DF_SHA"
rm -rf .git
echo "Checked out $DF_SHA"
"""

LOCAL_CLONE_SCRIPT = r"""
set -eu
rm -rf /workspace/src
git -c safe.directory='*' clone -q --no-hardlinks /source /workspace/src
cd /workspace/src
git checkout -q --detach "$DF_SHA"
test "$(git rev-parse HEAD)" = "$DF_SHA"
rm -rf .git
echo "Checked out $DF_SHA (local source)"
"""


class Runner:
    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self._active: dict[str, asyncio.subprocess.Process] = {}
        self._canceled: set[str] = set()

    # ───────────── workspaces ─────────────
    def workspace_dir(self, workspace_id: str) -> str:
        safety.check_ident(workspace_id, "workspace id")
        return os.path.join(self.s.workspace_root, workspace_id)

    def ensure_workspace(self, workspace_id: str) -> tuple[str, str]:
        d = self.workspace_dir(workspace_id)
        os.makedirs(os.path.join(d, ".home"), exist_ok=True)
        # the sandbox user must be able to write; the agent keeps ownership of the parent
        os.chmod(d, 0o777)  # noqa: S103 - isolated per-workspace dir, mounted only into one container
        os.chmod(os.path.join(d, ".home"), 0o777)  # noqa: S103
        return d, os.path.join(self.s.workspace_host_root, workspace_id)

    def delete_workspace(self, workspace_id: str) -> None:
        shutil.rmtree(self.workspace_dir(workspace_id), ignore_errors=True)

    # ───────────── steps ─────────────
    def _image(self, toolchain: str) -> str:
        try:
            return self.s.toolchains[toolchain]
        except KeyError:
            raise safety.UnsafeInput(f"unknown toolchain {toolchain!r}") from None

    def _limits(self, r: StepRequest) -> dockerargs.Limits:
        return dockerargs.Limits(
            memory_mb=int(safety.clamp(r.memory_mb, 2048, self.s.max_memory_mb)),
            cpus=float(safety.clamp(r.cpus, 2, self.s.max_cpus)),
            pids=int(safety.clamp(r.pids, 512, self.s.max_pids)),
        )

    def build_step_command(self, r: StepRequest) -> tuple[list[str], dict[str, str], list[str]]:
        """Return (container command, env for the container, extra docker args like mounts)."""
        env = safety.check_env(dict(r.env))
        extra: list[str] = []
        if r.kind == "clone":
            if r.source is None:
                raise safety.UnsafeInput("clone step requires a source")
            safety.check_sha(r.source.sha)
            env["DF_SHA"] = r.source.sha
            if r.source.kind == "https":
                env["DF_CLONE_URL"] = safety.check_clone_url(r.source.url)
                if r.source.token:
                    env["DF_GIT_TOKEN"] = r.source.token
                return dockerargs.shell(CLONE_SCRIPT), env, extra
            real = safety.check_local_source(r.source.path, self.s.dev_git_root)
            # the Docker daemon resolves bind mounts on the HOST, so translate the agent-side path
            host_real = real.replace(os.path.realpath(self.s.dev_git_root or ""), self.s.dev_git_host_root or "", 1)
            extra = ["-v", f"{host_real}:/source:ro"]
            return dockerargs.shell(LOCAL_CLONE_SCRIPT), env, extra
        cmd = safety.check_command(r.command or "")
        return dockerargs.shell(cmd), env, extra

    async def run_step(self, r: StepRequest) -> AsyncIterator[dict]:
        safety.check_ident(r.step_id, "step id")
        if r.timeout_seconds > self.s.max_timeout_seconds:
            raise safety.UnsafeInput("timeout exceeds agent maximum")
        image = self._image("git" if r.kind == "clone" else r.toolchain)
        _, host_dir = self.ensure_workspace(r.workspace_id)
        rel = safety.check_rel_dir(r.workdir)
        workdir = "/workspace" + (f"/{rel}" if rel else "")
        command, env, extra = self.build_step_command(r)
        name = f"df-step-{r.step_id}"
        network = "egress" if r.kind == "clone" else r.network
        argv = dockerargs.step_args(
            self.s, name=name, image=image, workspace_host_dir=host_dir, workdir=workdir,
            command=command, env=env, network=network, limits=self._limits(r),
        )
        if extra:  # insert extra mounts before the image
            idx = argv.index("--entrypoint")
            argv[idx:idx] = extra
        if r.kind == "clone":
            # git image runs as non-root too; entrypoint override above makes `sh` the program
            pass

        started = time.monotonic()
        proc_env = {**os.environ, **env}
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=proc_env,
        )
        self._active[r.step_id] = proc
        queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=2000)
        lines = 0

        async def pump(stream: asyncio.StreamReader, label: str) -> None:
            nonlocal lines
            while True:
                try:
                    raw = await stream.readuntil(b"\n")
                except asyncio.LimitOverrunError as e:
                    raw = await stream.readexactly(e.consumed)
                except asyncio.IncompleteReadError as e:
                    raw = e.partial
                if not raw:
                    return
                lines += 1
                if lines == self.s.max_log_lines_per_step + 1:
                    await queue.put({"type": "log", "stream": "system", "line": "[log output truncated: line limit reached]"})
                if lines > self.s.max_log_lines_per_step:
                    continue  # keep draining so the container is never blocked on a full pipe
                text = raw[: self.s.max_log_line].decode("utf-8", "replace").rstrip("\r\n")
                await queue.put({"type": "log", "stream": label, "line": text})

        readers = [
            asyncio.create_task(pump(proc.stdout, "stdout")),  # type: ignore[arg-type]
            asyncio.create_task(pump(proc.stderr, "stderr")),  # type: ignore[arg-type]
        ]

        async def finish() -> None:
            await asyncio.gather(*readers, return_exceptions=True)
            await queue.put(None)

        finisher = asyncio.create_task(finish())
        timed_out = False
        deadline = time.monotonic() + r.timeout_seconds
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=min(remaining, 5))
                except TimeoutError:
                    if r.step_id in self._canceled:
                        break
                    continue
                if item is None:
                    break
                yield item
                if r.step_id in self._canceled:
                    break
            if timed_out or r.step_id in self._canceled:
                await self._kill(name, proc)
                yield {"type": "log", "stream": "system", "line": "Step timed out" if timed_out else "Step canceled"}
            code = await asyncio.wait_for(proc.wait(), timeout=30)
        finally:
            await self._kill(name, proc)
            finisher.cancel()
            for t in readers:
                t.cancel()
            self._active.pop(r.step_id, None)
        canceled = r.step_id in self._canceled
        self._canceled.discard(r.step_id)
        oom = code == 137 and not timed_out and not canceled
        yield {
            "type": "result", "exit_code": code if code is not None else -1, "timed_out": timed_out,
            "canceled": canceled, "oom_killed": oom, "duration_ms": int((time.monotonic() - started) * 1000),
        }

    async def _kill(self, name: str, proc: asyncio.subprocess.Process) -> None:
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
        await self._docker("rm", "-f", name)

    def cancel(self, step_id: str) -> bool:
        if step_id in self._active:
            self._canceled.add(step_id)
            return True
        return False

    async def _docker(self, *args: str, timeout: float = 60) -> tuple[int, str]:
        p = await asyncio.create_subprocess_exec(
            self.s.docker_bin, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
        )
        try:
            out, _ = await asyncio.wait_for(p.communicate(), timeout=timeout)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                p.kill()
            return 124, "timeout"
        return p.returncode or 0, out.decode("utf-8", "replace")

    # ───────────── runtimes ─────────────
    @staticmethod
    def container_name(deployment_id: str) -> str:
        return f"df-rt-{safety.check_ident(deployment_id, 'deployment id')}"

    async def start_runtime(self, r: RuntimeRequest) -> RuntimeInfo:
        name = self.container_name(r.deployment_id)
        image = self._image(r.toolchain)
        env = safety.check_env(dict(r.env))
        if "PORT" in env:
            raise safety.UnsafeInput("PORT is set by the platform")
        health = safety.check_command(r.health_path)
        if not health.startswith("/") or any(c.isspace() for c in health):
            raise safety.UnsafeInput("invalid health path")
        app_dir = os.path.join(self.s.runtime_root, r.deployment_id)
        bundle = os.path.join(self.s.bundle_root, f"{r.deployment_id}.tar.gz")
        if not os.path.isfile(bundle):
            raise safety.UnsafeInput("bundle not uploaded")
        if not os.path.isdir(app_dir):
            await self._extract(bundle, app_dir)
        limits = dockerargs.Limits(
            memory_mb=int(safety.clamp(r.memory_mb, 512, self.s.max_memory_mb)),
            cpus=float(safety.clamp(r.cpus, 0.5, self.s.max_cpus)),
            pids=int(safety.clamp(r.pids, 256, self.s.max_pids)),
        )
        await self._docker("rm", "-f", name)
        argv = dockerargs.runtime_args(
            self.s, name=name, image=image,
            app_host_dir=os.path.join(self.s.runtime_host_root, r.deployment_id),
            command=dockerargs.shell(f"exec {safety.check_command(r.command)}"),
            env=env, port=r.port, limits=limits,
            labels={"deployforge.deployment": r.deployment_id, "deployforge.kind": "runtime"},
        )
        p = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env={**os.environ, **env}
        )
        out, err = await p.communicate()
        if p.returncode != 0:
            raise RuntimeError(f"docker run failed: {err.decode('utf-8', 'replace')[:300]}")
        deadline = time.monotonic() + r.startup_timeout_seconds
        info = await self.runtime_info(r.deployment_id, r.port, r.health_path)
        while time.monotonic() < deadline:
            info = await self.runtime_info(r.deployment_id, r.port, r.health_path)
            if info.status == "exited":
                break
            if info.healthy:
                return info
            await asyncio.sleep(1)
        await self.stop_runtime(r.deployment_id, keep_logs=True)
        return info.model_copy(update={"status": "unhealthy", "healthy": False})

    async def _extract(self, bundle: str, dest: str) -> None:
        os.makedirs(dest, exist_ok=True)
        # --no-same-owner/--no-same-permissions + GNU tar rejects absolute / '..' members by default.
        p = await asyncio.create_subprocess_exec(
            "tar", "-xzf", bundle, "-C", dest, "--no-same-owner", "--no-same-permissions",
            "--no-overwrite-dir", stderr=asyncio.subprocess.PIPE,
        )
        _, err = await p.communicate()
        if p.returncode != 0:
            shutil.rmtree(dest, ignore_errors=True)
            raise RuntimeError(f"bundle extraction failed: {err.decode()[:200]}")
        for root, dirs, files in os.walk(dest):  # defence in depth: no links may escape
            for n in dirs + files:
                full = os.path.join(root, n)
                if os.path.islink(full):
                    real = os.path.realpath(full)
                    if not real.startswith(os.path.realpath(dest) + os.sep):
                        shutil.rmtree(dest, ignore_errors=True)
                        raise RuntimeError("bundle contains a link that escapes the app directory")

    async def runtime_info(self, deployment_id: str, port: int, health_path: str = "/health") -> RuntimeInfo:
        name = self.container_name(deployment_id)
        code, out = await self._docker("inspect", "--format", "{{json .State}}", name, timeout=15)
        if code != 0:
            return RuntimeInfo(deployment_id=deployment_id, container=name, host=name, port=port, status="missing", healthy=False)
        state = json.loads(out.strip() or "{}")
        if not state.get("Running"):
            return RuntimeInfo(deployment_id=deployment_id, container=name, host=name, port=port, status="exited", healthy=False)
        healthy = await asyncio.to_thread(self._probe, name, port, health_path)
        return RuntimeInfo(
            deployment_id=deployment_id, container=name, host=name, port=port,
            status="running" if healthy else "starting", healthy=healthy,
        )

    @staticmethod
    def _probe(host: str, port: int, path: str) -> bool:
        try:
            with urllib.request.urlopen(f"http://{host}:{port}{path}", timeout=2) as resp:  # noqa: S310 - fixed scheme, internal name
                return 200 <= resp.status < 400
        except Exception:
            return False

    async def runtime_logs(self, deployment_id: str, tail: int) -> list[str]:
        code, out = await self._docker("logs", "--tail", str(max(1, min(tail, 1000))), self.container_name(deployment_id), timeout=15)
        if code != 0:
            return []
        return list(safety.iter_lines(out.encode(), self.s.max_log_line))

    async def stop_runtime(self, deployment_id: str, keep_logs: bool = False) -> None:
        name = self.container_name(deployment_id)
        await self._docker("stop", "-t", "15", name, timeout=40)  # graceful SIGTERM, then SIGKILL
        if not keep_logs:
            await self._docker("rm", "-f", name)
            shutil.rmtree(os.path.join(self.s.runtime_root, deployment_id), ignore_errors=True)
            with contextlib.suppress(FileNotFoundError):
                os.remove(os.path.join(self.s.bundle_root, f"{deployment_id}.tar.gz"))
