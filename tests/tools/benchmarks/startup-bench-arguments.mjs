/**
 * Shared CLI flags for the startup benchmarks.
 *
 * Both benchmarks must accept the fixture flags identically: an A/B run whose
 * profile shape differs from the single-arm run it is compared against is not
 * measuring the same startup.
 */
import { STATE_PROFILES } from './startup-profile-fixture.mjs'

/**
 * Flags describing the profile under test and how long a launch may take.
 *
 * `--iterations` is deliberately absent: the A/B bench counts launches in
 * `--pairs`, and a shared spec would make `--iterations 12` parse there and do
 * nothing.
 */
export const PROFILE_FLAG_SPEC = {
  '--files': { key: 'files', type: 'number', integer: true },
  '--fixture-dir': { key: 'fixtureDir', type: 'string' },
  '--timeout-ms': { key: 'timeoutMs', type: 'number', min: 1 },
  '--state-profile': { key: 'stateProfile', type: 'string' },
  '--session-tabs': { key: 'sessionTabs', type: 'number', integer: true },
  '--github-repos': { key: 'githubRepos', type: 'number', integer: true },
  '--gh-hang-ms': { key: 'ghHangMs', type: 'number' },
  '--wait-for-event': { key: 'waitForEvent', type: 'string' },
  '--linger-ms': { key: 'lingerMs', type: 'number' }
}

export const PROFILE_ARG_DEFAULTS = {
  files: 28000,
  fixtureDir: null,
  timeoutMs: 240000,
  stateProfile: 'none',
  sessionTabs: 0,
  githubRepos: 0,
  ghHangMs: 0,
  waitForEvent: 'did-finish-load',
  // How long the app stays alive after the awaited event before the harness
  // kills it. Raise to let background work (e.g. the async win32 ACL grant)
  // complete the way it would in a real session.
  lingerMs: 500
}

/** Only the single-arm bench repeats a launch itself; the A/B bench uses --pairs. */
export const SINGLE_ARM_FLAG_SPEC = {
  ...PROFILE_FLAG_SPEC,
  // min 1: --iterations 0 would launch nothing and still write a result file.
  '--iterations': { key: 'iterations', type: 'number', integer: true, min: 1 }
}

export const SINGLE_ARM_ARG_DEFAULTS = { ...PROFILE_ARG_DEFAULTS, iterations: 5 }

export function parseFlags(argv, spec, defaults) {
  const args = { ...defaults }
  for (let i = 2; i < argv.length; i++) {
    const flag = spec[argv[i]]
    if (!flag) {
      throw new Error(`Unknown argument: ${argv[i]}`)
    }
    if (flag.type === 'boolean') {
      args[flag.key] = true
      continue
    }
    const raw = argv[++i]
    if (raw === undefined) {
      throw new Error(`Missing value for ${argv[i - 1]}`)
    }
    if (flag.type === 'number') {
      const value = Number(raw)
      const min = flag.min ?? 0
      // Number('') is 0 and a negative parses fine, so an empty or negative
      // value would silently become an empty run or an instant timeout. A
      // fractional count is just as quiet: --iterations 1.5 runs twice.
      if (raw.trim() === '' || !Number.isFinite(value) || value < min) {
        throw new Error(`${argv[i - 1]} expects a number >= ${min}, got: ${raw}`)
      }
      if (flag.integer && !Number.isInteger(value)) {
        throw new Error(`${argv[i - 1]} expects a whole number, got: ${raw}`)
      }
      args[flag.key] = value
    } else {
      args[flag.key] = raw
    }
  }
  return args
}

export function assertStateProfile(stateProfile) {
  if (!STATE_PROFILES.includes(stateProfile)) {
    throw new Error(`Unknown state profile: ${stateProfile}`)
  }
}
