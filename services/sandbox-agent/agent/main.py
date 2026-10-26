"""Sandbox agent HTTP API (FastAPI). Internal-only: bound to the private network, bearer-token protected.

Never expose this service publicly: it can start containers.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import tarfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import safety
from .models import RuntimeInfo, RuntimeRequest, StepRequest, TreeResponse
from .runner import Runner
from .settings import Settings

log = structlog.get_logger("sandbox-agent")


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or Settings.from_env()
    runner = Runner(s)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        for d in (s.workspace_root, s.runtime_root, s.bundle_root):
            os.makedirs(d, exist_ok=True)
        yield

    app = FastAPI(title="DeployForge Sandbox Agent", version="0.1.0", lifespan=lifespan)

    async def auth(request: Request) -> None:
        given = request.headers.get("authorization", "")
        expected = f"Bearer {s.token}"
        if not hmac.compare_digest(given.encode(), expected.encode()):
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.exception_handler(safety.UnsafeInput)
    async def unsafe_handler(_: Request, exc: safety.UnsafeInput) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz() -> dict[str, str]:
        code, _ = await runner._docker("version", "--format", "{{.Server.Version}}", timeout=10)  # noqa: SLF001
        if code != 0:
            raise HTTPException(status_code=503, detail="docker engine unreachable")
        return {"status": "ready"}

    @app.post("/v1/steps", dependencies=[Depends(auth)])
    async def run_step(req: StepRequest) -> StreamingResponse:
        # validate eagerly so bad input is a 400 instead of a broken stream
        runner.build_step_command(req)
        if req.kind != "clone" and not req.command:
            raise safety.UnsafeInput("command required")
        runner._image("git" if req.kind == "clone" else req.toolchain)  # noqa: SLF001

        async def stream() -> AsyncIterator[bytes]:
            try:
                async for ev in runner.run_step(req):
                    yield (json.dumps(ev) + "\n").encode()
            except safety.UnsafeInput as e:
                yield (json.dumps({"type": "error", "message": str(e)}) + "\n").encode()
            except Exception:  # noqa: BLE001
                log.exception("step_failed", step_id=req.step_id)
                yield (json.dumps({"type": "error", "message": "internal agent error"}) + "\n").encode()

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    @app.delete("/v1/steps/{step_id}", dependencies=[Depends(auth)])
    async def cancel_step(step_id: str) -> dict[str, bool]:
        safety.check_ident(step_id, "step id")
        return {"canceled": runner.cancel(step_id)}

    @app.get("/v1/workspaces/{workspace_id}/tree", dependencies=[Depends(auth)])
    async def tree(workspace_id: str, dir: str = "", max_files: int = 10000, max_bytes: int = 500 << 20, max_file_bytes: int = 50 << 20) -> TreeResponse:  # noqa: A002
        root = safety.safe_join(runner.workspace_dir(workspace_id), "src" + (f"/{safety.check_rel_dir(dir)}" if safety.check_rel_dir(dir) else ""))
        if not os.path.isdir(root):
            raise HTTPException(status_code=404, detail="directory not found")
        try:
            files, total, skipped = safety.walk_tree(root, max_files=max_files, max_bytes=max_bytes, max_file_bytes=max_file_bytes)
        except safety.TreeLimitExceeded as e:
            raise HTTPException(status_code=413, detail=str(e)) from None
        return TreeResponse(files=[{"path": f.path, "size": f.size, "sha256": f.sha256} for f in files], total_size=total, skipped=skipped[:200])  # type: ignore[list-item]

    @app.get("/v1/workspaces/{workspace_id}/file", dependencies=[Depends(auth)])
    async def read_file(workspace_id: str, path: str) -> FileResponse:
        real = safety.open_regular_file(os.path.join(runner.workspace_dir(workspace_id), "src"), path)
        return FileResponse(real, media_type="application/octet-stream")

    @app.get("/v1/workspaces/{workspace_id}/pack", dependencies=[Depends(auth)])
    async def pack(workspace_id: str, dir: str = "", max_bytes: int = 500 << 20) -> FileResponse:  # noqa: A002
        """Tar.gz of the application directory (sources + installed dependencies) for runtime deployments."""
        ws = runner.workspace_dir(workspace_id)
        src = safety.safe_join(ws, "src" + (f"/{safety.check_rel_dir(dir)}" if safety.check_rel_dir(dir) else ""))
        deps = os.path.join(ws, "deps")
        out = os.path.join(s.bundle_root, f".pack-{re.sub(r'[^A-Za-z0-9_.-]', '_', workspace_id)}.tar.gz")
        total = 0
        with tarfile.open(out, "w:gz") as tar:
            for base, arc in ((src, "src"), (deps, "deps")):
                if not os.path.isdir(base):
                    continue
                for root, dirs, files in os.walk(base, followlinks=False):
                    dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d)) and d not in (".git",)]
                    for n in files:
                        full = os.path.join(root, n)
                        if os.path.islink(full) or not os.path.isfile(full):
                            continue
                        total += os.path.getsize(full)
                        if total > max_bytes:
                            os.remove(out)
                            raise HTTPException(status_code=413, detail="bundle too large")
                        tar.add(full, arcname=os.path.join(arc, os.path.relpath(full, base)), recursive=False)
        return FileResponse(out, media_type="application/gzip")

    @app.delete("/v1/workspaces/{workspace_id}", dependencies=[Depends(auth)])
    async def delete_workspace(workspace_id: str) -> dict[str, bool]:
        runner.delete_workspace(workspace_id)
        return {"deleted": True}

    @app.put("/v1/bundles/{deployment_id}", dependencies=[Depends(auth)])
    async def put_bundle(deployment_id: str, request: Request, max_bytes: int = 500 << 20) -> dict[str, int]:
        safety.check_ident(deployment_id, "deployment id")
        dest = os.path.join(s.bundle_root, f"{deployment_id}.tar.gz")
        tmp = dest + ".part"
        size = 0
        with open(tmp, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > max_bytes:
                    f.close()
                    os.remove(tmp)
                    raise HTTPException(status_code=413, detail="bundle too large")
                f.write(chunk)
        os.replace(tmp, dest)
        return {"size": size}

    @app.post("/v1/runtimes", dependencies=[Depends(auth)], response_model=RuntimeInfo)
    async def start_runtime(req: RuntimeRequest) -> RuntimeInfo:
        try:
            return await runner.start_runtime(req)
        except RuntimeError as e:
            raise HTTPException(status_code=502, detail=str(e)) from None

    @app.get("/v1/runtimes/{deployment_id}", dependencies=[Depends(auth)], response_model=RuntimeInfo)
    async def runtime_status(deployment_id: str, port: int = 8000, health_path: str = "/health") -> RuntimeInfo:
        info = await runner.runtime_info(deployment_id, port, health_path)
        if info.status == "missing":
            raise HTTPException(status_code=404, detail="runtime not found")
        return info

    @app.get("/v1/runtimes/{deployment_id}/logs", dependencies=[Depends(auth)])
    async def runtime_logs(deployment_id: str, tail: int = 200) -> dict[str, list[str]]:
        return {"lines": await runner.runtime_logs(deployment_id, tail)}

    @app.delete("/v1/runtimes/{deployment_id}", dependencies=[Depends(auth)])
    async def stop_runtime(deployment_id: str) -> dict[str, bool]:
        await runner.stop_runtime(deployment_id)
        return {"stopped": True}

    return app


def app_factory() -> FastAPI:  # `uvicorn agent.main:app_factory --factory`
    return create_app()
