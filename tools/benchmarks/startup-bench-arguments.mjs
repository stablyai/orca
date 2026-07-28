/**
 * Shared CLI flags for the startup benchmarks.
 *
 * Both benchmarks must accept the fixture flags identically: an A/B run whose
 * profile shape differs from the single-arm run it is compared against is not
 * measuring the same startup.
 */
import { STATE_PROFILES } from './startup-profile-fixture.mjs'

/** Flags describing the profile under test and how long a launch may take. */
export const FIXTURE_FLAG_SPEC = {
  '--iterations': { key: 'iterations', type: 'number' },
  '--files': { key: 'files', type: 'number' },
  '--fixture-dir': { key: 'fixtureDir', type: 'string' },
  '--timeout-ms': { key: 'timeoutMs', type: 'number' },
  '--state-profile': { key: 'stateProfile', type: 'string' },
  '--session-tabs': { key: 'sessionTabs', type: 'number' },
  '--github-repos': { key: 'githubRepos', type: 'number' },
  '--gh-hang-ms': { key: 'ghHangMs', type: 'number' },
  '--wait-for-event': { key: 'waitForEvent', type: 'string' },
  '--linger-ms': { key: 'lingerMs', type: 'number' }
}

export const FIXTURE_ARG_DEFAULTS = {
  iterations: 5,
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

export function parseFlags(argv, spec, defaults) {
  const args = { ...defaults }
  for (let i = 2; i < argv.length; i++) {
    const flag = spec[argv[i]]
    if (!flag) {
      throw new Error(`Unknown argument: ${argv[i]}`)
    }
    const raw = argv[++i]
    if (raw === undefined) {
      throw new Error(`Missing value for ${argv[i - 1]}`)
    }
    if (flag.type === 'number') {
      const value = Number(raw)
      if (!Number.isFinite(value)) {
        throw new Error(`${argv[i - 1]} expects a number, got: ${raw}`)
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
