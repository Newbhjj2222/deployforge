# GitHub App setup

1. GitHub → Settings → Developer settings → GitHub Apps → New. Webhook URL `https://<APP_HOST>/api/webhooks/github`, a long random webhook secret (= `GITHUB_WEBHOOK_SECRET`).
2. Permissions (minimum): Repository **Contents: read**, **Metadata: read**. (Optional later: Commit statuses/Checks write.)
3. Subscribe to events: **Push**, **Installation**, **Installation repositories**.
4. Generate a private key; set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` (PEM, `\n`-escaped or base64 per `.env.example`).
5. Users install the app from the dashboard → GitHub page; installations are linked to the signed-in user's organization.
6. Installation tokens are minted on demand, scoped to a single repository with read-only contents, and never stored.
