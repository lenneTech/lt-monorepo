#!/usr/bin/env node
/**
 * Contract test for the "packageManager as single source of truth" policy.
 *
 * Node >= 25 no longer ships corepack, so nothing may depend on `corepack
 * enable` anymore. Instead the root package.json carries an EXACT pnpm pin
 * (version + sha512 suffix) and every CI job derives its pnpm from that pin:
 *
 *   npm install -g "$(node -p "require('./package.json').packageManager.split('+')[0]")"
 *
 * This script asserts the contract holds:
 *   1. The pin is exact (pnpm@X.Y.Z+sha512.<hash> — no range, hash present).
 *   2. engines.pnpm equals "^<MAJOR>.0.0" of the pinned version.
 *   3. CI files (.gitlab-ci.yml + .github/workflows/*.yml) use the derive-line —
 *      no hardcoded `npm install -g pnpm@<digits>`, no `corepack enable`, and no
 *      pnpm/action-setup step with a `version:` input (the action reads the
 *      packageManager field on its own).
 *   4. FUNCTIONAL proof (only with CI=1 or PIN_PROVISION_TEST=1 — needs network
 *      and ~10MB, so it must not slow local pre-push hooks): the derive-line
 *      really resolves to the pinned spec, and `npm install -g --prefix <tmp>`
 *      of that spec delivers a pnpm whose `--version` IS the pinned version.
 *
 * Exit code: 0 when the contract holds, 1 otherwise.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = "[packagemanager-pin]";

const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`${TAG} ok — ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`${TAG} FAIL — ${name}\n  ${err.message.split("\n").join("\n  ")}`);
  }
}

// ---------------------------------------------------------------------------
// 1 + 2: the pin itself
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

check("packageManager is an exact pnpm pin with sha512 hash", () => {
  assert.match(
    pkg.packageManager ?? "",
    /^pnpm@\d+\.\d+\.\d+\+sha512\.[A-Za-z0-9]+$/,
    `root package.json must pin "pnpm@X.Y.Z+sha512.<hash>", got "${pkg.packageManager}"`,
  );
});

const pinnedSpec = (pkg.packageManager ?? "").split("+")[0]; // e.g. "pnpm@11.13.1"
const pinnedVersion = pinnedSpec.split("@")[1] ?? "";
const pinnedMajor = pinnedVersion.split(".")[0];

check(`engines.pnpm matches the pin's major (^${pinnedMajor}.0.0)`, () => {
  assert.equal(
    pkg.engines?.pnpm,
    `^${pinnedMajor}.0.0`,
    `engines.pnpm must be "^${pinnedMajor}.0.0", got "${pkg.engines?.pnpm}"`,
  );
});

// ---------------------------------------------------------------------------
// 3: CI files derive pnpm from the pin instead of hardcoding a version
// ---------------------------------------------------------------------------
const DERIVE_PATTERN = "packageManager.split('+')[0]";

// .gitlab-ci.yml + every GitHub workflow. deploy.yml runs no pnpm, but it must
// still be free of hardcoded installs / corepack — scanning all of them is cheap.
const ciFiles = [".gitlab-ci.yml"];
try {
  for (const f of readdirSync(join(ROOT, ".github", "workflows"))) {
    if (f.endsWith(".yml") || f.endsWith(".yaml")) ciFiles.push(join(".github", "workflows", f));
  }
} catch {
  // no GitHub workflows — nothing to add
}

// Files that install pnpm at all MUST use the derive-line. Only test.yml and
// .gitlab-ci.yml run pnpm today; keep this list in sync when a workflow starts to.
const mustDerive = [".gitlab-ci.yml", join(".github", "workflows", "test.yml")];

for (const rel of ciFiles) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  // Strip comment lines: prose ABOUT corepack (like the comment shipped next to
  // the derive-line) is fine — only executable occurrences are violations.
  const code = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  check(`${rel} has no hardcoded "npm install -g pnpm@<version>"`, () => {
    assert.doesNotMatch(code, /npm install -g pnpm@\d/, "replace it with the derive-line");
  });
  check(`${rel} does not rely on corepack`, () => {
    assert.doesNotMatch(code, /corepack/, "Node >= 25 no longer ships corepack");
  });
  check(`${rel} has no pnpm/action-setup with a version input`, () => {
    // The action reads packageManager itself; a version input would duplicate the pin.
    const usesAction = /uses:\s*pnpm\/action-setup/.test(code);
    if (usesAction) {
      assert.doesNotMatch(
        code,
        /pnpm\/action-setup[\s\S]{0,200}?version:/,
        "drop the version: input — the action reads the packageManager field",
      );
    }
  });
  if (mustDerive.includes(rel)) {
    check(`${rel} provisions pnpm via the derive-line`, () => {
      assert.ok(
        text.includes(DERIVE_PATTERN),
        `expected "${DERIVE_PATTERN}" — every pnpm-running job must derive pnpm from package.json`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// 3b: Dockerfiles derive pnpm from the pin too. The deploy images build the
// production artifact (turboops-build → docker-compose → projects/*/Dockerfile);
// a stale `corepack prepare pnpm@<old>` there installs a DIFFERENT pnpm than the
// one that generated pnpm-lock.yaml + pnpm-workspace.yaml, so a `--frozen-lockfile`
// install can fail (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH) or build prod with a
// mismatched manager. This scan closes the blind spot that let that drift ship.
// ---------------------------------------------------------------------------
const dockerFiles = [];
const collectDockerfiles = (dir) => {
  try {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (/^Dockerfile/.test(f)) dockerFiles.push(dir === "." ? f : join(dir, f));
    }
  } catch {
    /* directory absent — nothing to scan */
  }
};
collectDockerfiles(".");
try {
  for (const d of readdirSync(join(ROOT, "projects"), { withFileTypes: true })) {
    if (d.isDirectory()) collectDockerfiles(join("projects", d.name));
  }
} catch {
  /* no projects/ (single-package repo) */
}

for (const rel of dockerFiles) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), "utf8");
  } catch {
    continue;
  }
  // Strip comment lines: prose about corepack (the "corepack-free" note next to
  // the derive-line) is fine — only executable RUN occurrences are violations.
  const code = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  check(`${rel} does not rely on corepack`, () => {
    assert.doesNotMatch(code, /corepack/, "Node >= 25 no longer ships corepack — derive pnpm from the pin");
  });
  check(`${rel} has no hardcoded pnpm@<version>`, () => {
    assert.doesNotMatch(
      code,
      /pnpm@\d/,
      "derive pnpm from package.json's packageManager pin instead of hardcoding a version",
    );
  });
  // A Dockerfile that actually runs pnpm must provision it via the derive-line.
  // The negative lookbehind skips path tokens like `/pnpm` (an `ENV PNPM_HOME=/pnpm`
  // or a `COPY --from=build /pnpm /pnpm` store copy) so a pnpm-free runtime stage
  // isn't wrongly forced to carry the derive-line.
  if (/(?<!\/)\bpnpm\s/.test(code)) {
    check(`${rel} provisions pnpm via the derive-line`, () => {
      assert.ok(
        text.includes(DERIVE_PATTERN),
        `expected "${DERIVE_PATTERN}" — a Dockerfile that runs pnpm must derive it from package.json`,
      );
    });
  }
}

// ---------------------------------------------------------------------------
// 4: functional proof — derive + provision into a throwaway prefix
// ---------------------------------------------------------------------------
if (process.env.CI || process.env.PIN_PROVISION_TEST) {
  check(`derive-line resolves to "${pinnedSpec}"`, () => {
    const derived = execFileSync(
      "node",
      ["-p", "require('./package.json').packageManager.split('+')[0]"],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
    ).trim();
    assert.equal(derived, pinnedSpec);
  });

  check(`npm install -g of the derived spec delivers pnpm ${pinnedVersion}`, () => {
    const prefix = mkdtempSync(join(tmpdir(), "pin-provision-"));
    try {
      execFileSync("npm", ["install", "-g", "--prefix", prefix, pinnedSpec], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 180_000,
      });
      const version = execFileSync(join(prefix, "bin", "pnpm"), ["--version"], {
        encoding: "utf8",
        timeout: 30_000,
      }).trim();
      assert.equal(version, pinnedVersion);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
} else {
  console.log(`${TAG} skipped functional provisioning proof (set CI=1 or PIN_PROVISION_TEST=1 to run it)`);
}

// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\n${TAG} ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`${TAG} all checks passed — pin ${pkg.packageManager}`);
