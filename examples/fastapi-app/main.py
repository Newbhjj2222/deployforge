import os

from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def index() -> dict[str, str]:
    # APP_GREETING is a runtime environment variable configured in the dashboard
    return {"message": os.environ.get("APP_GREETING", "Hello from a DeployForge Python app")}
