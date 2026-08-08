/**
 * Shared serve-option guards for the CLI (`orca serve`) and the in-process
 * packaged-binary path (`<binary> serve …` → getServeOptions). Keep both
 * surfaces identical so a typo or contradictory flag cannot silently open a
 * network-exposed runtime with pairing still enabled (#13006).
 */

export type ServeOptionGuardInput = {
  noPairing: boolean
  mobilePairing: boolean
  recipeJson: boolean
  projectRoot: string | null | undefined
}

/** Cross-flag incompatibilities; null when the combination is valid. */
export function getServeOptionGuardError(input: ServeOptionGuardInput): string | null {
  if (input.noPairing && input.mobilePairing) {
    return 'Use either --mobile-pairing or --no-pairing, not both.'
  }
  if (input.recipeJson && input.noPairing) {
    return 'Recipe JSON output requires runtime pairing; remove --no-pairing.'
  }
  if (input.recipeJson && input.mobilePairing) {
    return 'Recipe JSON output requires runtime pairing; remove --mobile-pairing.'
  }
  if (input.recipeJson && !input.projectRoot) {
    return 'Recipe JSON output requires --project-root.'
  }
  return null
}

/**
 * Known serve flag tokens (CLI form + rewritten `--serve-*` form). Tokens
 * outside this set that still look like serve pairing flags are treated as
 * typos — Chromium switches do not share these names.
 */
const KNOWN_SERVE_FLAG_NAMES = new Set([
  '--json',
  '--serve-json',
  '--no-pairing',
  '--serve-no-pairing',
  '--mobile-pairing',
  '--serve-mobile-pairing',
  '--recipe-json',
  '--serve-recipe-json',
  '--port',
  '--serve-port',
  '--pairing-address',
  '--serve-pairing-address',
  '--project-root',
  '--serve-project-root',
  '--serve',
  '--help',
  '-h'
])

/** Security-shaped flags: a near-miss must not silently keep pairing on. */
const SECURITY_SERVE_FLAGS = [
  '--no-pairing',
  '--serve-no-pairing',
  '--mobile-pairing',
  '--serve-mobile-pairing',
  '--recipe-json',
  '--serve-recipe-json',
  '--pairing-address',
  '--serve-pairing-address'
] as const

function flagName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

/** Small Levenshtein for short flag names (edit distance ≤ 2 is a typo). */
function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0
  }
  const rows = a.length + 1
  const cols = b.length + 1
  const dist: number[] = Array.from({ length: cols }, (_, i) => i)
  for (let i = 1; i < rows; i += 1) {
    let prev = dist[0]!
    dist[0] = i
    for (let j = 1; j < cols; j += 1) {
      const temp = dist[j]!
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dist[j] = Math.min(dist[j]! + 1, dist[j - 1]! + 1, prev + cost)
      prev = temp
    }
  }
  return dist[b.length]!
}

function closestSecurityServeFlag(name: string): string | null {
  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of SECURITY_SERVE_FLAGS) {
    // Skip when lengths differ too much to be a 1–2 edit typo.
    if (Math.abs(name.length - candidate.length) > 2) {
      continue
    }
    const distance = editDistance(name, candidate)
    if (distance > 0 && distance <= 2 && distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * Reject serve-related typos (e.g. `--no-pairng`, `--no-paring`) that would
 * otherwise pass through to Electron and leave pairing enabled. Open Chromium
 * switches are far from the security flag set, so they still ride through.
 * Stops at `--` so post-terminator positionals are not re-interpreted.
 */
export function getServeFlagTypoError(argv: readonly string[]): string | null {
  for (const token of argv) {
    if (token === '--') {
      break
    }
    if (!token.startsWith('-')) {
      continue
    }
    const name = flagName(token)
    if (KNOWN_SERVE_FLAG_NAMES.has(name)) {
      continue
    }
    const suggestion = closestSecurityServeFlag(name)
    if (suggestion) {
      return `Unknown flag ${name}. Did you mean ${suggestion}?`
    }
  }
  return null
}
