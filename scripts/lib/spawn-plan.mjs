/**
 * How to start a package-manager command so it also runs on Windows.
 *
 * On Windows `pnpm` and `npm` are `.cmd` shims, and Node has refused to spawn a `.cmd` file without
 * a shell since 20.12 (CVE-2024-27980): `execFileSync('pnpm', args)` dies with `EINVAL` before the
 * command runs. With a shell, Node deprecates passing an args array next to it (DEP0190), because it
 * only concatenates them unescaped. So on Windows the plan is ONE command string with every token
 * quoted for cmd.exe, and no args array. On every other platform nothing changes: the program and
 * its arguments go to `execFileSync` as before, with no shell in between.
 *
 * The platform is a parameter so the tests can drive both branches from macOS and Linux CI, the
 * same convention `check.mjs` uses for `pinCheckBuildDir()` and `killTreePlan()`.
 */
import { join } from 'node:path';

/** Tokens cmd.exe passes through unchanged. */
const CMD_SAFE = /^[\w@+=:,./\\-]+$/;

/**
 * Characters no quoting makes safe in cmd.exe: `%VAR%` is expanded INSIDE double quotes too, a `"`
 * inside a token cannot be escaped reliably, and a line break ends the command.
 */
const CMD_UNQUOTABLE = /["%\r\n]/;

/**
 * Quote one token for cmd.exe.
 *
 * A token from the safe set passes unchanged. Anything else (a temp path with a space in the user
 * name, typically) is wrapped in double quotes, which make `&`, `|`, `<`, `>`, `^` and parentheses
 * literal. A token cmd.exe cannot carry intact is REFUSED with an error rather than passed on in a
 * changed form: running a different command than the one written, or against a different path, is
 * worse than not running at all.
 */
export function quoteForCmd(token) {
  const text = String(token);
  if (text !== '' && CMD_SAFE.test(text)) {
    return text;
  }
  if (CMD_UNQUOTABLE.test(text)) {
    throw new Error(
      `cannot pass ${JSON.stringify(text)} to cmd.exe intact (it contains ", % or a line break); ` +
        'run the command without it, or from a POSIX shell',
    );
  }
  // Trailing backslashes are doubled: node.exe (and the CRT rules every Windows program parses its
  // command line with) reads `\"` as a literal quote, which would merge this token with the next.
  return `"${text.replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * The `execFileSync` arguments for a command on the given platform.
 *
 * @returns `{ file, args, options }` — spread `options` into the call's own options.
 */
export function commandPlan(command, args = [], platform = process.platform) {
  if (platform !== 'win32') {
    return { args, file: command, options: {} };
  }
  return { args: [], file: [command, ...args].map(quoteForCmd).join(' '), options: { shell: true } };
}

/**
 * Where `npm install -g --prefix <prefix> pnpm@…` puts the pnpm executable.
 *
 * npm lays out a global prefix differently per platform: `<prefix>/bin/pnpm` on POSIX, but
 * `<prefix>/pnpm.cmd` directly in the prefix on Windows.
 */
export function provisionedPnpmPath(prefix, platform = process.platform) {
  return platform === 'win32' ? join(prefix, 'pnpm.cmd') : join(prefix, 'bin', 'pnpm');
}
