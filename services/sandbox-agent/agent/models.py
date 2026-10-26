from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Ident = Annotated[str, StringConstraints(min_length=1, max_length=100)]


class HttpsSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["https"]
    url: str
    sha: str
    token: str | None = Field(default=None, repr=False)


class LocalSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["local"]
    path: str
    sha: str


class StepRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    step_id: Ident
    kind: Literal["clone", "install", "build"]
    workspace_id: Ident
    toolchain: Ident
    command: str | None = None
    env: dict[str, str] = Field(default_factory=dict, repr=False)
    workdir: str = ""
    timeout_seconds: int = Field(gt=0, le=7200)
    network: Literal["none", "egress"] = "none"
    memory_mb: int | None = None
    cpus: float | None = None
    pids: int | None = None
    source: Annotated[HttpsSource | LocalSource, Field(discriminator="kind")] | None = None


class RuntimeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    deployment_id: Ident
    toolchain: Ident
    command: str
    port: int = Field(ge=1024, le=65535)
    health_path: str = "/health"
    env: dict[str, str] = Field(default_factory=dict, repr=False)
    memory_mb: int | None = None
    cpus: float | None = None
    pids: int | None = None
    startup_timeout_seconds: int = Field(default=60, ge=5, le=300)


class RuntimeInfo(BaseModel):
    deployment_id: str
    container: str
    host: str
    port: int
    status: Literal["starting", "running", "exited", "missing", "unhealthy"]
    healthy: bool


class TreeFileModel(BaseModel):
    path: str
    size: int
    sha256: str


class TreeResponse(BaseModel):
    files: list[TreeFileModel]
    total_size: int
    skipped: list[str]
