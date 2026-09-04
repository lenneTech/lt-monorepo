/**
 * Tests for the audit summary accounting.
 *
 * This is the part of the report that can be wrong while every number still adds up: it decides
 * whether a real, unassessed CRITICAL is shown as `critical 1` or quietly folded into "already
 * looked at". Both directions have been shipped here before, which is why each case below states
 * the failure it pins rather than only the expectation.
 *
 * The report shapes are measured, not invented — see the comments on each fixture.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  advisoryBulkUrl,
  auditVerdict,
  countSuppressions,
  countUnlisted,
  countUnlistedBySeverity,
  assessedSeverities,
  isAuditEndpointUnavailable,
  isAuditResultAmbiguous,
  renderVulnLine,
  sumSeverities,
} from './audit-report.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { force: true, recursive: true });
    } catch {
      /* best effort */
    }
  }
});

/** A throwaway workspace root carrying the given files. */
function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'lt-audit-'));
  dirs.push(root);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  return root;
}

const vulns = (over = {}) => ({ critical: 0, high: 0, info: 0, low: 0, moderate: 0, ...over });

// pnpm's shape. `advisories` is an object keyed by id; it is present on every run, including a
// clean one and one where the threshold filtered everything out.
const pnpmReport = (counts, advisories = {}) => ({
  advisories,
  metadata: { vulnerabilities: counts },
});
// npm 7+ emits `auditReportVersion: 2` with a `vulnerabilities` MAP and no `advisories` key.
const npmV2Report = (counts) => ({
  auditReportVersion: 2,
  metadata: { vulnerabilities: counts },
  vulnerabilities: {},
});

describe('countUnlistedBySeverity', () => {
  it('reports the gap per severity, not as one number', () => {
    // A scalar cannot say WHICH row is unlisted, and `critical 1 · moderate 2 (2 not listed)`
    // then reads as "the critical is handled".
    const parsed = pnpmReport(vulns({ critical: 1, moderate: 2 }), { a: { severity: 'critical' } });
    assert.deepEqual(countUnlistedBySeverity(parsed), vulns({ moderate: 2 }));
    assert.equal(countUnlisted(parsed), 2);
  });

  it('returns all-zero when `advisories` is ABSENT, instead of deriving from it', () => {
    // The npm-v2 shape. Deriving here would report `critical 0` with the whole tally filed under
    // "already assessed" — a real, unassessed critical rendered as handled.
    const parsed = npmV2Report(vulns({ critical: 1 }));
    assert.deepEqual(countUnlistedBySeverity(parsed), vulns());
    assert.equal(countUnlisted(parsed), 0);
  });

  it('treats `advisories: {}` as present-and-empty, not as absent', () => {
    // pnpm emits an empty object on a clean run AND when the threshold filtered everything out.
    // Conflating it with "absent" would hide exactly the below-threshold case.
    assert.deepEqual(countUnlistedBySeverity(pnpmReport(vulns({ info: 1 }))), vulns({ info: 1 }));
  });

  it('never goes negative when more advisories are listed than counted', () => {
    const parsed = pnpmReport(vulns({ high: 1 }), {
      a: { severity: 'high' },
      b: { severity: 'high' },
    });
    assert.deepEqual(countUnlistedBySeverity(parsed), vulns());
  });

  it('survives a report with no counts at all', () => {
    assert.deepEqual(countUnlistedBySeverity({ advisories: {} }), vulns());
    assert.deepEqual(countUnlistedBySeverity(null), vulns());
  });
});

describe('countSuppressions', () => {
  it('counts block-form entries under ignoreGhsas', () => {
    const root = workspace({
      'pnpm-workspace.yaml': 'auditConfig:\n  ignoreGhsas:\n    - GHSA-aaaa-bbbb-cccc\n    - GHSA-dddd-eeee-ffff\n',
    });
    assert.equal(countSuppressions(root), 2);
  });

  it('counts the inline form', () => {
    const root = workspace({
      'pnpm-workspace.yaml': 'auditConfig:\n  ignoreGhsas: [GHSA-aaaa-bbbb-cccc]\n',
    });
    assert.equal(countSuppressions(root), 1);
  });

  it('does NOT count a suppression that was retired into a comment', () => {
    // This is the case that decides the whole feature in this repo: lt-monorepo documents a
    // WITHDRAWN GHSA in comments directly under an empty `ignoreGhsas: []`. Counting it would
    // claim an assessment that was explicitly revoked — the same false claim, inverted.
    const root = workspace({
      'pnpm-workspace.yaml':
        'auditConfig:\n  # Removed 2026-08-22: GHSA-mh99-v99m-4gvg — the upstream range was narrowed.\n  ignoreGhsas: []\n',
    });
    assert.equal(countSuppressions(root), 0);
  });

  it('returns 0 — the loud direction — when there is nothing it can parse', () => {
    assert.equal(countSuppressions(workspace({})), 0);
    assert.equal(countSuppressions(workspace({ 'pnpm-workspace.yaml': 'packages:\n  - x\n' })), 0);
  });
});

describe('assessedSeverities', () => {
  const counts = vulns({ high: 1 });

  it('dims a fully-unlisted severity when a suppression exists and the gate passed', () => {
    const dim = assessedSeverities({
      blocking: false,
      counts,
      suppressions: 1,
      unlisted: vulns({ high: 1 }),
    });
    assert.deepEqual([...dim], ['high']);
  });

  it('dims NOTHING without a configured suppression', () => {
    // Without one, every unlisted finding is below pnpm's default `low` threshold and nobody has
    // assessed anything. Dimming there is the exact failure this accounting exists to prevent.
    const dim = assessedSeverities({
      blocking: false,
      counts,
      suppressions: 0,
      unlisted: vulns({ high: 1 }),
    });
    assert.equal(dim.size, 0);
  });

  it('dims NOTHING on a failing gate, however the numbers look', () => {
    const dim = assessedSeverities({
      blocking: true,
      counts,
      suppressions: 5,
      unlisted: vulns({ high: 1 }),
    });
    assert.equal(dim.size, 0);
  });

  it('keeps a partially-unlisted severity loud', () => {
    const dim = assessedSeverities({
      blocking: false,
      counts: vulns({ moderate: 3 }),
      suppressions: 1,
      unlisted: vulns({ moderate: 2 }),
    });
    assert.equal(dim.size, 0, 'one live finding in the row is enough to keep it loud');
  });
});

describe('renderVulnLine', () => {
  const plain = (s) => s.replace(/\[[0-9;]*m/g, '');
  const isDimmed = (line, severity) => new RegExp(`\\u001b\\[2m${severity} \\d+`).test(line);
  const isYellow = (line, severity) => new RegExp(`\\u001b\\[33m${severity} \\d+`).test(line);
  const isRed = (line, severity) => new RegExp(`\\u001b\\[31m${severity} \\d+`).test(line);

  it('annotates the unlisted count and names the severity', () => {
    const line = renderVulnLine({
      blocking: false,
      counts: vulns({ moderate: 1 }),
      suppressions: 0,
      unlisted: vulns({ moderate: 1 }),
    });
    assert.match(plain(line), /\(1 moderate not listed\)/);
    assert.doesNotMatch(plain(line), /assessed/, 'must not claim a judgement nobody made');
  });

  it('leaves a below-threshold finding LOUD when nothing is suppressed', () => {
    // The measured live case: pnpm's default threshold is `low`, so an info finding is dropped
    // from `advisories` under a bare `pnpm audit` — no flag, no config. Nobody assessed it.
    const line = renderVulnLine({
      blocking: false,
      counts: vulns({ info: 1 }),
      suppressions: 0,
      unlisted: vulns({ info: 1 }),
    });
    assert.equal(isDimmed(line, 'info'), false, 'an unassessed finding must not be greyed out');
  });

  it('marks the assessed row YELLOW — visible, not hidden — and leaves a live critical red', () => {
    // Yellow, not grey, since 2026-09-04: a greyed-out suppression stops being looked at. In
    // nest-server one sat obsolete for five weeks for exactly that reason. Asserted as "is yellow"
    // rather than "is not dim", because the second passes for red, for white, and for a row that
    // was never coloured at all.
    const line = renderVulnLine({
      blocking: false,
      counts: vulns({ critical: 1, moderate: 2 }),
      suppressions: 1,
      unlisted: vulns({ moderate: 2 }),
    });
    assert.equal(isYellow(line, 'moderate'), true, 'an assessed row must stay visible');
    assert.equal(isDimmed(line, 'moderate'), false, 'and must not be greyed out');
    assert.equal(isRed(line, 'critical'), true, 'a live critical stays red');
  });

  it('adds no annotation when nothing is unlisted', () => {
    const line = renderVulnLine({
      blocking: false,
      counts: vulns({ high: 1 }),
      suppressions: 1,
      unlisted: vulns(),
    });
    assert.doesNotMatch(plain(line), /not listed/);
  });

  it('still annotates on a failing gate — only the dimming is suppressed', () => {
    const line = renderVulnLine({
      blocking: true,
      counts: vulns({ critical: 1 }),
      suppressions: 3,
      unlisted: vulns({ critical: 1 }),
    });
    assert.match(plain(line), /\(1 critical not listed\)/, 'the count stays true on a red run');
    assert.equal(isDimmed(line, 'critical'), false);
  });

  it('does not throw on a record with no counts', () => {
    assert.equal(typeof renderVulnLine({}), 'string');
  });
});

describe('isAuditEndpointUnavailable', () => {
  it('recognises the retired legacy endpoint', () => {
    assert.equal(isAuditEndpointUnavailable('ERR_PNPM_AUDIT_BAD_RESPONSE  something'), true);
    assert.equal(isAuditEndpointUnavailable('The audit endpoint has been retired by npm'), true);
  });

  it("recognises pnpm's error envelope for a transient outage", () => {
    // The shape observed 2026-09-04, when `registry.npmjs.org` answered 200 in 0.24s while
    // `/-/npm/v1/security/advisories/bulk` timed out. It reded three sibling repos in one hour.
    const envelope = '{"error":{"code":23,"message":"The operation was aborted due to timeout"}}';
    assert.equal(isAuditEndpointUnavailable(envelope), true);
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']) {
      assert.equal(isAuditEndpointUnavailable(`{"error":{"message":"${code}"}}`), true, code);
    }
    assert.equal(isAuditEndpointUnavailable('{"error":{"code":503,"message":"Service Unavailable"}}'), true);

    // MEASURED, not invented: this is what pnpm 11.14.0 emits when the registry connection is
    // refused. The list was originally built from the timeout case alone and did not match it —
    // found by pointing a real `pnpm audit` at an unreachable registry rather than by re-reading
    // the regex.
    assert.equal(isAuditEndpointUnavailable('{"error":{"code":"pnpm","message":"fetch failed"}}'), true);
    for (const code of ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'socket hang up']) {
      assert.equal(isAuditEndpointUnavailable(`{"error":{"message":"${code}"}}`), true, code);
    }
  });

  it('does NOT degrade an auth failure — that is configuration, not weather', () => {
    // Two halves, and only the SECOND one tests the guard. A plain "Unauthorized" never reaches the
    // word list at all, so those two lines stay green even with the auth branch deleted — they pin
    // that the word list does not match plain auth text, which is worth having and is NOT coverage
    // of the guard. Verified by mutation: removing the guard fails only the lines below.
    assert.equal(isAuditEndpointUnavailable('{"error":{"code":401,"message":"Unauthorized"}}'), false);
    assert.equal(isAuditEndpointUnavailable('{"error":{"code":403,"message":"Forbidden"}}'), false);

    // These degraded until 2026-09-04: the word list ran over `code + message` together, so any auth
    // error mentioning a timeout was read as weather. That is the dangerous direction — a broken
    // registry token would report "vulnerabilities not checked" forever and, unlike an outage, never
    // resolve on its own. The comment on the function PROMISED auth stayed fatal; nobody had tested
    // it, because the promise was checked with messages that could not have failed either way.
    assert.equal(isAuditEndpointUnavailable('{"error":{"code":401,"message":"Unauthorized: session timeout"}}'), false);
    assert.equal(isAuditEndpointUnavailable('{"error":{"code":403,"message":"Forbidden, request aborted"}}'), false);
  });

  it('reads a 5xx from the numeric code, not from any number in the text', () => {
    // `\b5\d\d\b` matched any 500-599 anywhere in the message, so `audited 503 packages` was
    // enough to degrade a perfectly good failure.
    assert.equal(isAuditEndpointUnavailable('{"error":{"code":"pnpm","message":"audited 503 packages"}}'), false);
    assert.equal(isAuditEndpointUnavailable('{"error":{"code":503,"message":"Service Unavailable"}}'), true);
  });

  it('does NOT degrade merely because the output failed to parse', () => {
    // The loose rule — "no parseable counts means infrastructure" — would turn any unexplained
    // audit failure into a pass. The gate would then be green for a reason nobody chose.
    assert.equal(isAuditEndpointUnavailable('Segmentation fault'), false);
    assert.equal(isAuditEndpointUnavailable('{ not json'), false);
    assert.equal(isAuditEndpointUnavailable(''), false);
  });

  it('does NOT degrade a real report that happens to mention a timeout', () => {
    // A finding always arrives as a report, never as an `error` envelope. Matching the word
    // anywhere in the output would swallow an advisory whose title contains it.
    const report = JSON.stringify({
      advisories: { a: { severity: 'high', title: 'DoS via request timeout handling' } },
      metadata: { vulnerabilities: vulns({ high: 1 }) },
    });
    assert.equal(isAuditEndpointUnavailable(report), false);
  });
});

describe('auditVerdict', () => {
  const report = (counts, advisories = {}) => ({ advisories, metadata: { vulnerabilities: counts } });

  it('degrades a hang without looking at anything else', () => {
    // The measured shape: killed after the ceiling, no output at all, so there is nothing to
    // classify. It is an outage, not a finding.
    assert.equal(auditVerdict({ code: 1, out: '', parsed: undefined, timedOut: true }), 'degraded-unreachable');
  });

  it('degrades a known infrastructure signature', () => {
    const out = '{"error":{"code":"pnpm","message":"fetch failed"}}';
    assert.equal(auditVerdict({ code: 1, out, parsed: JSON.parse(out) }), 'degraded-unreachable');
  });

  it('BLOCKS a non-zero exit that carries no infrastructure signature', () => {
    // The trap this ordering exists for: folding this in with the "nothing readable" case below
    // would turn every genuine audit failure into a warning — a worse bug than the one fixed.
    assert.equal(auditVerdict({ code: 1, out: 'Segmentation fault', parsed: undefined }), 'fail');
    assert.equal(
      auditVerdict({ code: 1, out: '{"error":{"code":401,"message":"Unauthorized"}}', parsed: undefined }),
      'fail',
    );
  });

  it('degrades exit 0 with nothing readable — separately from an outage', () => {
    // Observed: a pnpm version mismatch answering on stderr with exit 0 and no JSON. Rendered as a
    // green tick beside a literal `0` before this existed. Its own verdict because it is usually
    // LOCAL, and "wait for the service" would be the wrong instruction.
    assert.equal(
      auditVerdict({ code: 0, out: '[ERROR] wrong pnpm version', parsed: undefined }),
      'degraded-unreadable',
    );
  });

  it('asks the service when the report is ambiguous, and only then', () => {
    assert.equal(auditVerdict({ code: 0, out: '', parsed: report(vulns()) }), 'ask-service');
    // A listed advisory proves the service answered, so no probe is needed. The verdict follows the
    // exit code, not the count — asserted here as "does not ask" rather than as a specific outcome,
    // because the outcome is the previous test's subject and mixing them is how one assertion ends
    // up standing in for two properties.
    assert.notEqual(
      auditVerdict({ code: 0, out: '', parsed: report(vulns({ high: 1 }), { a: { severity: 'high' } }) }),
      'ask-service',
    );
  });

  it('resolves the ambiguous case from the answer it was given', () => {
    const parsed = report(vulns());
    assert.equal(auditVerdict({ code: 0, out: '', parsed, serviceReachable: true }), 'ok');
    assert.equal(auditVerdict({ code: 0, out: '', parsed, serviceReachable: false }), 'degraded-unreachable');
  });

  it('never blocks on counts alone — the exit code is the gate', () => {
    // Writing this test is what found the bug: the first version returned 'fail' whenever the
    // severity total was above zero, EVEN with exit 0. That makes the wrapper stricter than a bare
    // `pnpm audit`, which is the one thing both `.gitlab-ci.yml` and `check.mjs` promise it is not:
    // a count above zero with exit 0 is exactly what `--audit-level` is for. Real findings come
    // back as a non-zero exit and are caught by the branch above.
    assert.equal(auditVerdict({ code: 0, out: '', parsed: report(vulns({ info: 1 })) }), 'ok');
    assert.equal(
      auditVerdict({ code: 0, out: '', parsed: report(vulns({ moderate: 1 }), { a: { severity: 'moderate' } }) }),
      'ok',
    );
    // The same findings with the exit code pnpm actually sets for them: blocked.
    assert.equal(
      auditVerdict({ code: 1, out: 'x', parsed: report(vulns({ critical: 1 }), { a: { severity: 'critical' } }) }),
      'fail',
    );
  });
});

describe('advisoryBulkUrl', () => {
  it('derives the endpoint from the CONFIGURED registry, not from npmjs.org', () => {
    // The probe has to ask the same service the audit asked. Hardcoding npmjs.org while pnpm
    // resolves against a private registry reproduces the very bug the probe exists to prevent:
    // pnpm fails silently against the private one, npmjs.org answers, and the run goes green.
    assert.equal(
      advisoryBulkUrl('https://npm.internal.example/'),
      'https://npm.internal.example/-/npm/v1/security/advisories/bulk',
    );
  });

  it('tolerates a missing trailing slash and a nested path', () => {
    assert.equal(
      advisoryBulkUrl('https://proxy.example/repo/npm'),
      'https://proxy.example/repo/npm/-/npm/v1/security/advisories/bulk',
    );
    assert.equal(advisoryBulkUrl('https://a.example///'), 'https://a.example/-/npm/v1/security/advisories/bulk');
  });

  it('falls back to npmjs.org when the registry cannot be determined', () => {
    for (const empty of ['', '   ', null, undefined]) {
      assert.match(advisoryBulkUrl(empty), /^https:\/\/registry\.npmjs\.org\//, String(empty));
    }
  });
});

describe('isAuditResultAmbiguous', () => {
  it('flags the shape a dead advisory service produces', () => {
    // MEASURED 2026-09-04 while `/-/npm/v1/security/advisories/bulk` answered HTTP 000 after 25s
    // and `registry.npmjs.org` answered 200 in 0.17s. pnpm exited 0 and reported a clean tree:
    // byte-identical to a genuinely clean run, no error envelope, nothing to key on. That green
    // `✓ audit  critical 0 · …` is why this predicate exists.
    assert.equal(isAuditResultAmbiguous(pnpmReport(vulns())), true);
  });

  it('is NOT ambiguous once anything was listed', () => {
    // A listed advisory proves the service answered, whatever the counts say.
    assert.equal(isAuditResultAmbiguous(pnpmReport(vulns({ high: 1 }), { a: { severity: 'high' } })), false);
  });

  it('is NOT ambiguous when counts exist without advisories', () => {
    // Everything below pnpm's default `low` threshold: it answered, the entries were filtered.
    assert.equal(isAuditResultAmbiguous(pnpmReport(vulns({ info: 2 }))), false);
  });

  it('leaves the npm-v2 shape alone', () => {
    // No `advisories` key at all is a different report, judged by countUnlistedBySeverity.
    assert.equal(isAuditResultAmbiguous(npmV2Report(vulns())), false);
    assert.equal(isAuditResultAmbiguous(null), false);
  });
});

describe('sumSeverities', () => {
  it('sums the reported severities and tolerates gaps', () => {
    assert.equal(sumSeverities(vulns({ critical: 1, low: 2 })), 3);
    assert.equal(sumSeverities({ high: 1 }), 1);
    assert.equal(sumSeverities(null), 0);
  });
});
