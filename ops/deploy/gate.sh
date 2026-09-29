#!/usr/bin/env bash
# The only thing the GitHub Actions deploy key can do. authorized_keys pins that key to this script:
#   restrict,command="/opt/plico/gate.sh" ssh-ed25519 AAAA… github-actions-deploy@criox4/plico
# The runner sends `deploy <commit sha>` with a short-lived GHCR token on stdin. compose.yml and deploy.sh are not
# shipped by the runner (a leaked key could otherwise run its own script as root): after changing them in the repo,
# copy them to /opt/plico by hand. The image itself can only come from this repo's GHCR, which only CI can push to.
set -euo pipefail
read -r cmd sha extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[[ $cmd == deploy && $sha =~ ^[0-9a-f]{40}$ && -z ${extra:-} ]] || { echo "not allowed" >&2; exit 1; }
cd /opt/plico
docker login ghcr.io -u criox4 --password-stdin >/dev/null
exec bash deploy.sh "$sha"
