#!/usr/bin/env node
/**
 * `pnpm audit` for CI — with the one question the audit cannot answer about itself.
 *
 * WHY THIS EXISTS. A bare `pnpm audit` cannot be trusted to have run. Measured 2026-09-04, while
 * `/-/npm/v1/security/advisories/bulk` answered HTTP 000 after 25s and `registry.npmjs.org`
 * answered 200 in 0.17s:
 *
 *   pnpm audit --json  ->  exit 0
 *                          metadata.vulnerabilities {info:0,low:0,moderate:0,high:0,critical:0}
 *                          advisories {}            (present, empty)
 *                          NO error envelope
 *
 * pnpm fails OPEN. Byte for byte the report a genuinely clean repository produces, so the exit code
 * and the JSON are both useless for telling the two apart. The CI audit job runs `pnpm audit`
 * directly — it does not go through `scripts/check.mjs` — so during an outage it goes GREEN while
 * nothing was checked, and `deploy.yml` gates its deploy on that workflow. A green audit is
 * precisely the claim nobody can afford to have wrong.
 *
 * WHAT IT DOES. Runs the audit, then: findings -> fail, as before. Nothing reported -> ask the
 * advisory service whether it was reachable at all, and say so when it was not. A run WITH findings
 * costs no extra request: findings prove the service answered.
 *
 * WHY AN UNREACHABLE SERVICE DOES NOT FAIL THE JOB. `.gitlab-ci.yml` argues at length that this job
 * must block, and it is right — but that argument is about ADVISORIES ("a red audit job means a NEW
 * advisory that nobody has assessed yet"). An outage is not an advisory, nobody can act on it, and
 * failing every pipeline during one is how `allow_failure: true` came back the last time. It is
 * reported loudly instead, on stderr, and the step is named in the log so nobody has to infer it.
 *
 * Exit code: non-zero when the audit found something, or when it failed for a reason that is NOT a
 * known infrastructure signature. Zero when clean-and-verified, and zero-with-a-warning when the
 * service could not be reached.
 */
import { execFileSync } from 'node:child_process';

import {
  advisoryBulkUrl,
  auditVerdict,
  configuredRegistry,
  isAuditEndpointUnavailable,
  sumSeverities,
} from './lib/audit-report.mjs';

// Derived from the registry pnpm actually resolves against. A hardcoded npmjs.org URL would
// answer while a private registry is down, turning this safeguard into a second false all-clear.
const BULK_ENDPOINT = advisoryBulkUrl(configuredRegistry());
const PROBE_TIMEOUT_MS = 8000;

/**
 * Any HTTP answer proves the service is up — a 4xx to an empty body is still an answer.
 *
 * KNOWN RESIDUAL, stated rather than implied. The probe samples a DIFFERENT MOMENT than the audit
 * did. "Unreachable" is strong evidence: the audit almost certainly could not ask either. "Reachable"
 * is weaker — it proves the service answers now, not that it answered during the audit a minute ago.
 *
 * The window is real, not theoretical: measured 2026-09-04, three back-to-back attempts gave
 * timeout / timeout / HTTP 200 in 0.57s. So a run whose audit fell in a dead window and whose probe
 * fell in a live one still reports clean.
 *
 * Accepted deliberately. Closing it means re-running the audit whenever the probe succeeds, which
 * doubles the slowest step to narrow a window that a sustained outage — the shape that actually
 * bites, and the one this exists for — does not have. This turns the common case from a silent
 * false all-clear into a named warning; it does not turn the audit into a proof.
 */
async function advisoryServiceReachable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(BULK_ENDPOINT, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: controller.signal,
    });
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A hang is an outage too, and pnpm does hang.
 *
 * Measured 2026-09-04 against an unreachable registry: `pnpm audit --json` produced NO output and
 * had to be killed after 240s — no error envelope, no exit code, nothing to classify. Without a
 * ceiling this script inherits that: a CI job that never returns, burning the runner until the
 * instance-wide timeout, with a log that says nothing about why.
 *
 * 180s is well past a healthy audit (sub-second when the service answers, ~45s when it is merely
 * slow) and well under any sensible job timeout. A kill lands in the same bucket as a refused
 * connection, which is what it is.
 */
const AUDIT_TIMEOUT_MS = 180_000;

function runAudit() {
  // The extra args are passed through, so a project can narrow the scope in its own CI file
  // without this script having to know about `--prod` or `--audit-level`.
  const args = ['audit', '--json', ...process.argv.slice(2)];
  try {
    return {
      code: 0,
      out: execFileSync('pnpm', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: AUDIT_TIMEOUT_MS,
      }),
    };
  } catch (err) {
    // `killed` / ETIMEDOUT is the hang. Reported as the infrastructure case rather than as a
    // finding, because that is what it is — and it must not read as "audit failed for some reason",
    // which is fatal below.
    if (err.killed || err.code === 'ETIMEDOUT') {
      return { code: 1, timedOut: true, out: `pnpm audit produced no result within ${AUDIT_TIMEOUT_MS / 1000}s` };
    }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/**
 * Retry before degrading, because a retry can turn "we could not check" into "we checked".
 *
 * The outage is intermittent, not sustained: measured 2026-09-04, three back-to-back probes gave
 * timeout / timeout / HTTP 200 in 0.57s, and a peer session saw an audit fail and then succeed
 * immediately afterwards with a real result (1 moderate). Degrading on the first failure throws
 * that away and reports "not checked" for something that was one attempt from being checked.
 *
 * Deliberately HERE rather than as GitLab's `retry:` on the job. Two reasons, and the first is
 * decisive: this script exits 0 on an outage — on purpose, so a npm outage does not red every
 * pipeline — and GitLab only retries a FAILING job, so a job-level retry would never fire for the
 * case it was meant for. The second: `retry:` is GitLab-only, while this runs in GitHub Actions and
 * on developer machines too.
 *
 * pnpm already retries internally (3 attempts, 10s then 60s), so these are attempts on top of a
 * fetch that has itself given up — hence few, with a short pause rather than a long backoff.
 */
const AUDIT_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Did this attempt fail for an infrastructure reason — the only kind worth repeating? */
const isInfrastructureFailure = (r) =>
  r.timedOut || (r.code !== 0 && !r.parsedCounts && isAuditEndpointUnavailable(r.out));

let result;
for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt += 1) {
  result = runAudit();
  try {
    result.parsedCounts = JSON.parse(result.out.slice(result.out.indexOf('{')))?.metadata?.vulnerabilities ?? null;
  } catch {
    result.parsedCounts = null;
  }
  if (!isInfrastructureFailure(result) || attempt === AUDIT_ATTEMPTS) break;
  process.stderr.write(
    `[audit] attempt ${attempt}/${AUDIT_ATTEMPTS} could not reach the advisory service — retrying in ${RETRY_PAUSE_MS / 1000}s\n`,
  );
  await sleep(RETRY_PAUSE_MS);
}

const { code, out, timedOut } = result;

let parsed;
try {
  parsed = JSON.parse(out.slice(out.indexOf('{')));
} catch {
  parsed = undefined;
}

// One decision, taken by `auditVerdict` in the lib so a test can reach it. This block used to hold
// the branching inline, where the only way to exercise it was a real `pnpm audit` — a security
// gate whose deciding lines were, in practice, untested.
let verdict = auditVerdict({ code, out, parsed, timedOut });
if (verdict === 'ask-service') {
  verdict = auditVerdict({ code, out, parsed, serviceReachable: await advisoryServiceReachable(), timedOut });
}

if (verdict === 'degraded-unreachable') {
  process.stderr.write(
    '[audit] WARNING: the npm advisory service could not be reached — vulnerabilities were NOT\n' +
      '[audit] checked. `pnpm audit` fails OPEN and reports a clean tree either way, so a green\n' +
      '[audit] result here would establish NOTHING.\n' +
      '[audit] Not failing the job: an outage is not a finding. Re-run once the service is back.\n',
  );
  process.exit(0);
}

if (verdict === 'degraded-unreadable') {
  // Named apart from the outage on purpose: this one is usually LOCAL and therefore actionable —
  // a pnpm version mismatch answering on stderr with exit 0 and no JSON produces exactly this.
  // "Wait for the service" would be the wrong instruction; it never resolves on its own.
  process.stderr.write(
    '[audit] WARNING: `pnpm audit` exited 0 but emitted no readable result — vulnerabilities were\n' +
      '[audit] NOT checked. This is usually local: check the audit command itself.\n' +
      `[audit] Output was:\n${out}\n`,
  );
  process.exit(0);
}

if (verdict === 'fail') {
  const total = sumSeverities(parsed?.metadata?.vulnerabilities);
  process.stderr.write(
    total > 0
      ? `[audit] ${total} vulnerability/vulnerabilities reported:\n${out}\n`
      : `[audit] FAILED (exit ${code}):\n${out}\n`,
  );
  process.exit(1);
}

console.log('[audit] ok — no known vulnerabilities (advisory service confirmed reachable)');
