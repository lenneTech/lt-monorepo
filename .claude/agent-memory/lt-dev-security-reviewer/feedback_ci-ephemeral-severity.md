---
name: ci-ephemeral-severity
description: Severity calibration for documented, genuinely-ephemeral CI values (throwaway creds, test DBs) in this repo's security reviews
metadata:
  type: feedback
---

Rate documented, genuinely-ephemeral CI values (e.g. throwaway admin creds targeting a per-job mongo service container) as **Low/Info with explicit reasoning**, not inflated Medium/High.

**Why:** The team deliberately commits throwaway CI creds (e.g. `ci-admin@test.com` / `CiThrowawayAdmin123!` for the E2E setup-seed) and documents them as throwaway. Inflating these buries the real findings. The review-quality bar is honest, non-inflated severity with a stated exploit path (or lack of one).

**How to apply:** Before rating a committed CI credential, trace whether it can reach a real environment — check it is NOT passed as a Docker build arg (would bake into the image) and NOT referenced by build/deploy jobs (only by the ephemeral test job). If the path is closed and the value is documented as throwaway → Info/Low. Still note template-wide propagation (see [[template-repo-nature]]) and that it must never be configured in a real env. Reserve Medium+ for governance gaps (auto-deploy without branch protection / protected+masked tokens) and disabled transport security (e.g. `DOCKER_TLS_CERTDIR:""`).
