FROM python:3.12-slim-bookworm
# The agent needs the docker CLI (it talks to the host engine through the mounted socket). This is the
# ONLY container in the platform that receives the socket: it must run on a private network, behind a
# bearer token, and must never run user code itself. See docs/security.md.
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io tar ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/agent
COPY pyproject.toml ./
RUN pip install --no-cache-dir "fastapi>=0.115,<1" "uvicorn[standard]>=0.30,<1" "pydantic>=2.8,<3" "structlog>=24.1,<26"
COPY agent ./agent
ENV PYTHONUNBUFFERED=1
EXPOSE 8700
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8700/healthz',timeout=2)"
CMD ["uvicorn", "agent.main:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8700", "--no-access-log"]
