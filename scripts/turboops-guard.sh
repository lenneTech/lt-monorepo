#!/usr/bin/env sh
# ======================================================================================================================
# Fail fast on a broken TurboOps setup, before a CI job spends minutes building.
#
# Shared by .gitlab-ci.yml and .github/workflows/deploy.yml so the checks stay in
# one place. POSIX sh only — it runs in `docker:*-dind` (BusyBox) as well as on
# ubuntu-latest.
#
# Checks:
#   1. TURBOOPS_PROJECT + TURBOOPS_TOKEN are set.
#   2. .turboops.json exists in the repo root (`turbo deploy` reads it there).
#   3. .turboops.json's `project` matches TURBOOPS_PROJECT.
#
# Why (3) matters: the image push uses $TURBOOPS_PROJECT as the registry
# namespace, while `turbo deploy` takes the project from .turboops.json. If the
# two drift apart, CI pushes images into namespace A and rolls out project B —
# a silent, very confusing deploy of a stale image.
# ======================================================================================================================
set -e

if [ -z "$TURBOOPS_PROJECT" ] || [ -z "$TURBOOPS_TOKEN" ]; then
  echo "TURBOOPS_PROJECT and TURBOOPS_TOKEN must be set as CI/CD variables (token masked)."
  echo "Run \`lt deployment create\` for the full setup checklist."
  exit 1
fi

if [ ! -f .turboops.json ]; then
  echo ".turboops.json is missing from the repo root — \`turbo deploy\` needs it."
  echo "Run \`lt deployment create\` and commit the file."
  exit 1
fi

if ! grep -qE "\"project\"[[:space:]]*:[[:space:]]*\"${TURBOOPS_PROJECT}\"" .turboops.json; then
  echo ".turboops.json does not match TURBOOPS_PROJECT=${TURBOOPS_PROJECT}:"
  # `sed` (not `cat`) so a file without a trailing newline still ends the line.
  sed 's/^/  /' .turboops.json
  echo ""
  echo "Images would be pushed to one namespace and a different project deployed."
  exit 1
fi

echo "TurboOps setup OK — project \"${TURBOOPS_PROJECT}\"."
