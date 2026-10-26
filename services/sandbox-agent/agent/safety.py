"""Pure validation helpers. No I/O except filesystem *inspection* in the tree walker.

Everything that decides "is this safe?" lives here so it can be unit-tested without Docker.
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Iterator
from dataclasses import dataclass

IDENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

FORBIDDEN_ENV_PREFIXES = ("LD_", "DYLD_", "DOCKER_", "SANDBOX_")
FORBIDDEN_ENV_KEYS = {"PATH", "HOME", "USER", "SHELL", "PWD", "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "BASH_ENV", "ENV"}
MAX_ENV_VALUE = 32 * 1024
MAX_ENV_COUNT = 300


class UnsafeInput(ValueError):
    """Raised for anything the agent refuses to act on. Mapped to HTTP 400."""


def check_ident(value: str, what: str = "identifier") -> str:
    if not IDENT_RE.match(value):
        raise UnsafeInput(f"invalid {what}")
    return value


def check_sha(value: str) -> str:
    if not SHA_RE.match(value):
        raise UnsafeInput("commit sha must be 40 lowercase hex characters")
    return value


def check_rel_dir(value: str, *, allow_empty: bool = True) -> str:
    """Relative directory inside a workspace: no absolute paths, no '..', no control chars."""
    v = value.strip().replace("\\", "/")
    if v in ("", ".", "./"):
        if allow_empty:
            return ""
        raise UnsafeInput("directory required")
    v = v.removeprefix("./").rstrip("/")
    if v.startswith("/") or _CONTROL.search(v) or len(v) > 300:
        raise UnsafeInput("invalid directory")
    for seg in v.split("/"):
        if seg in ("", ".", ".."):
            raise UnsafeInput("invalid directory")
    return v


def safe_join(root: str, rel: str) -> str:
    """Join and prove the *real* result stays inside root (resolves symlinks)."""
    rel = check_rel_dir(rel) if rel else ""
    root_real = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root_real, rel))
    if target != root_real and not target.startswith(root_real + os.sep):
        raise UnsafeInput("path escapes workspace")
    return target


def check_env(env: dict[str, str]) -> dict[str, str]:
    if len(env) > MAX_ENV_COUNT:
        raise UnsafeInput("too many environment variables")
    for k, v in env.items():
        if not ENV_KEY_RE.match(k):
            raise UnsafeInput(f"invalid environment variable name: {k[:40]!r}")
        up = k.upper()
        if up in FORBIDDEN_ENV_KEYS or up.startswith(FORBIDDEN_ENV_PREFIXES):
            raise UnsafeInput(f"environment variable {k!r} is reserved")
        if len(v) > MAX_ENV_VALUE or "\x00" in v:
            raise UnsafeInput(f"invalid value for {k!r}")
    return env


def check_command(cmd: str) -> str:
    if not cmd.strip() or len(cmd) > 4000 or "\x00" in cmd:
        raise UnsafeInput("invalid command")
    return cmd


_HTTPS_URL = re.compile(r"^https://[A-Za-z0-9.-]+(?::\d+)?/[A-Za-z0-9._~/-]+\.git$")


def check_clone_url(url: str) -> str:
    """Only credential-free https clone URLs; credentials travel separately and never in argv."""
    if not _HTTPS_URL.match(url) or "@" in url or ".." in url:
        raise UnsafeInput("invalid clone url")
    return url


def check_local_source(path: str, allowed_root: str | None) -> str:
    if not allowed_root:
        raise UnsafeInput("local sources are disabled")
    real = os.path.realpath(path)
    root = os.path.realpath(allowed_root)
    if real != root and not real.startswith(root + os.sep):
        raise UnsafeInput("local source outside the allowed root")
    if not os.path.isdir(real):
        raise UnsafeInput("local source not found")
    return real


def clamp(value: float | int | None, default: float | int, maximum: float | int) -> float | int:
    if value is None or value <= 0:
        return min(default, maximum)
    return min(value, maximum)


@dataclass(frozen=True)
class TreeFile:
    path: str
    size: int
    sha256: str


class TreeLimitExceeded(Exception):
    pass


def _hidden(name: str) -> bool:
    return name.startswith(".") and name != ".well-known"


def walk_tree(
    root: str,
    *,
    max_files: int,
    max_bytes: int,
    max_file_bytes: int,
) -> tuple[list[TreeFile], int, list[str]]:
    """Enumerate regular files below `root` for publishing.

    * Symlinks (files or directories) are NEVER followed or published; they are reported as skipped.
    * Hidden entries (".env", ".git", ...) are skipped, except ".well-known".
    * Hard limits abort with TreeLimitExceeded instead of silently truncating.
    """
    files: list[TreeFile] = []
    skipped: list[str] = []
    total = 0
    root_real = os.path.realpath(root)

    def rel(p: str) -> str:
        return os.path.relpath(p, root_real).replace(os.sep, "/")

    stack = [root_real]
    while stack:
        current = stack.pop()
        with os.scandir(current) as it:
            entries = sorted(it, key=lambda e: e.name)
        for e in entries:
            if _hidden(e.name):
                skipped.append(rel(e.path))
                continue
            if e.is_symlink():
                skipped.append(rel(e.path))
                continue
            if e.is_dir(follow_symlinks=False):
                if e.name == "node_modules":
                    skipped.append(rel(e.path))
                    continue
                stack.append(e.path)
            elif e.is_file(follow_symlinks=False):
                size = e.stat(follow_symlinks=False).st_size
                if size > max_file_bytes:
                    raise TreeLimitExceeded(f"file too large: {rel(e.path)}")
                total += size
                if total > max_bytes:
                    raise TreeLimitExceeded("total size limit exceeded")
                if len(files) >= max_files:
                    raise TreeLimitExceeded("file count limit exceeded")
                files.append(TreeFile(rel(e.path), size, sha256_file(e.path)))
            else:
                skipped.append(rel(e.path))  # sockets, fifos, devices
    files.sort(key=lambda f: f.path)
    return files, total, skipped


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def open_regular_file(root: str, rel_path: str) -> str:
    """Return a real path for a regular, non-symlink, non-hidden file inside root, else raise."""
    rel_path = check_rel_dir(rel_path, allow_empty=False)
    if any(_hidden(s) for s in rel_path.split("/")):
        raise UnsafeInput("hidden files are not served")
    root_real = os.path.realpath(root)
    candidate = os.path.join(root_real, rel_path)
    # refuse if ANY component is a symlink (realpath alone would silently follow it)
    cur = root_real
    for seg in rel_path.split("/"):
        cur = os.path.join(cur, seg)
        if os.path.islink(cur):
            raise UnsafeInput("symlinks are not served")
    real = os.path.realpath(candidate)
    if not real.startswith(root_real + os.sep) or not os.path.isfile(real):
        raise UnsafeInput("file not found")
    return real


def iter_lines(buf: bytes, limit: int) -> Iterator[str]:
    for raw in buf.split(b"\n"):
        yield raw[:limit].decode("utf-8", "replace").rstrip("\r")
