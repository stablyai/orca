import { spawnSync } from 'node:child_process'

/**
 * Locates the fish binary live shell tests run against, and decides how strict
 * they are about finding one.
 *
 * Why the strictness is configurable: on a developer machine without fish these
 * suites must skip, but the `shell contracts` CI job is a required check whose
 * fish lane is the only end-to-end guard for #9993. There, a skip would report
 * green with nothing exercised, so ORCA_REQUIRE_FISH=1 turns it into a failure.
 */
const FISH_CANDIDATES = ['fish', '/opt/homebrew/bin/fish', '/usr/local/bin/fish'] as const

/** Env var CI sets to make a missing or too-old fish fail instead of skip. */
export const REQUIRE_FISH_ENV_VAR = 'ORCA_REQUIRE_FISH'

export type FishBinaryLookup =
  | { available: true; path: string; majorVersion: number }
  | { available: false; path: null; majorVersion: number; reason: string }

export function resolveFishBinary(minMajorVersion = 1): FishBinaryLookup {
  if (process.platform === 'win32') {
    return {
      available: false,
      path: null,
      majorVersion: 0,
      reason: 'fish is not supported on Windows'
    }
  }

  for (const path of FISH_CANDIDATES) {
    const probe = spawnSync(path, ['--version'], { encoding: 'utf8' })
    if (probe.status !== 0) {
      continue
    }
    const majorVersion = Number(/version (\d+)/.exec(probe.stdout ?? '')?.[1] ?? '0')
    if (majorVersion < minMajorVersion) {
      return {
        available: false,
        path: null,
        majorVersion,
        reason: `fish ${minMajorVersion}+ required, found ${probe.stdout?.trim() || 'an unknown version'} at ${path}`
      }
    }
    return { available: true, path, majorVersion }
  }

  return { available: false, path: null, majorVersion: 0, reason: 'no fish binary on PATH' }
}

/**
 * The message to fail with when CI demanded fish and did not get it, else null.
 *
 * Assert this in a test that always runs, so the requirement cannot vanish with
 * the suite it guards.
 */
export function fishRequirementViolation(
  lookup: FishBinaryLookup,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (lookup.available || env[REQUIRE_FISH_ENV_VAR] !== '1') {
    return null
  }
  return `${REQUIRE_FISH_ENV_VAR}=1 but the live fish tests would skip: ${lookup.reason}`
}
