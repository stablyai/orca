// Argument parsing for `node run.mjs` (crash-survival harness).
//
// Unlike win-update-e2e, this harness installs nothing: it drives an ALREADY
// installed, packaged Orca.exe. So its only source is `--exe-path` (defaulting
// to the per-user install location). Exactly one profile (--expect) is required.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { locateInstalledExe } from '../win-update-e2e/installer-steps.mjs'

const VALID_PROFILES = new Set(['survival', 'orphaned'])
const VALUE_FLAGS = new Set(['--expect', '--exe-path', '--soak-seconds'])
const BOOLEAN_FLAGS = new Set(['--keep-profile'])

const USAGE = `
win-crash-survival-e2e — packaged crash-survival proof harness (Windows only)

Proves that force-killing ONLY Orca's main process (a real crash, no tree-kill)
leaves the detached terminal daemon + its pwsh shell alive, with no pwsh FailFast
(0xE9 "No process is on the other end of the pipe"), and that a relaunch ADOPTS
the surviving daemon instead of forking a new one. See #7742.

Usage:
  node tools/win-crash-survival-e2e/run.mjs --expect <profile> [--exe-path <Orca.exe>] [options]

Required:
  --expect <profile>       Assertion profile:
                           survival = the fixed behavior (daemon + shell survive
                             the main crash, zero pwsh FailFast, relaunch adopts
                             the same daemon PID). This is what must keep passing.
                           orphaned = the OLD broken #7742 behavior (daemon dies
                             with main, pwsh FailFasts). Directional inverse used
                             to prove the harness actually catches a regression;
                             on a fixed build this profile is EXPECTED to fail.

Options:
  --exe-path <path>        Installed Orca.exe to drive (default: the per-user
                           install under %LOCALAPPDATA%\\Programs\\Orca). The
                           harness NEVER installs/uninstalls — it only launches
                           this exe against an isolated userData dir.
  --soak-seconds <n>       Post-crash observation window before relaunch (default: 8)
  --keep-profile           Skip temp-profile cleanup at teardown (for debugging)
  -h, --help               Show this help
`

export function parseArgs(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    return { help: true, usage: USAGE }
  }

  const exePathFlagPresent = argv.includes('--exe-path')
  const opts = {
    // Only auto-locate on win32: off-win32 this would needlessly spawn powershell,
    // and run.mjs asserts win32 first so the platform message wins over any
    // "no Orca.exe found" default-resolution error.
    exePath:
      takeValue(argv, '--exe-path') ??
      (process.platform === 'win32' ? locateInstalledExe() : undefined) ??
      undefined,
    expect: takeValue(argv, '--expect'),
    soakSeconds: Number(takeValue(argv, '--soak-seconds') ?? '8'),
    keepProfile: argv.includes('--keep-profile'),
    usage: USAGE
  }

  const errors = validate(opts, exePathFlagPresent, argv)
  return { ...opts, errors }
}

function validate(opts, exePathFlagPresent, argv) {
  const errors = []
  errors.push(...validateArgShape(argv))
  if (!opts.expect) {
    errors.push('Missing --expect <survival|orphaned>')
  } else if (!VALID_PROFILES.has(opts.expect)) {
    errors.push(`Invalid --expect "${opts.expect}" (expected survival or orphaned)`)
  }
  // Distinguish "--exe-path omitted" (fall back to auto-locate) from
  // "--exe-path with no value" (a mistake that must fail, not silently default).
  if (exePathFlagPresent && takeValue(argv, '--exe-path') === undefined) {
    errors.push('--exe-path requires a path value')
  } else if (!opts.exePath) {
    errors.push(
      'No installed Orca.exe found under %LOCALAPPDATA%\\Programs — pass --exe-path <Orca.exe>'
    )
  } else if (!existsSync(opts.exePath)) {
    errors.push(`--exe-path does not exist: ${opts.exePath}`)
  } else if (!path.isAbsolute(opts.exePath)) {
    errors.push(`--exe-path must be an absolute path (got "${opts.exePath}")`)
  }
  if (!Number.isFinite(opts.soakSeconds) || opts.soakSeconds < 0) {
    errors.push('--soak-seconds must be a non-negative number')
  }
  return errors
}

function validateArgShape(argv) {
  const errors = []
  const seen = new Set()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!VALUE_FLAGS.has(arg) && !BOOLEAN_FLAGS.has(arg)) {
      errors.push(`Unknown argument: ${arg}`)
      continue
    }
    if (seen.has(arg)) {
      errors.push(`Duplicate argument: ${arg}`)
    }
    seen.add(arg)
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('--')) {
        index++
      }
    }
  }
  return errors
}

function takeValue(argv, flag) {
  const idx = argv.indexOf(flag)
  if (idx < 0) {
    return undefined
  }
  const value = argv[idx + 1]
  if (value === undefined || value.startsWith('--')) {
    return undefined
  }
  return value
}
