import { levenshtein } from './edit-distance'

export type ServeOptionValidationInput = {
  /** Explicit --bind value; undefined/null means the host's default listener. */
  bind?: string | null
  noPairing: boolean
  mobilePairing: boolean
  grantDesktopControl?: boolean
  allowPublic?: boolean
  refusePublic?: boolean
  recipeJson: boolean
  projectRoot: string | null | undefined
}

export function getServeOptionValidationError(options: ServeOptionValidationInput): string | null {
  if (options.noPairing && options.mobilePairing) {
    return 'Use either --mobile-pairing or --no-pairing, not both.'
  }
  if (options.mobilePairing && options.bind && options.bind !== '0.0.0.0') {
    // Mobile offers widen the listener to all interfaces, which a pinned --bind refuses, so the QR could never be served.
    return '--mobile-pairing needs --bind 0.0.0.0 (or no --bind); a narrower --bind cannot serve the mobile pairing offer.'
  }
  if (options.grantDesktopControl && (options.noPairing || options.mobilePairing)) {
    return '--grant-desktop-control applies only to the default runtime pairing offer.'
  }
  if (options.allowPublic && options.refusePublic) {
    return 'Use either --allow-public or --refuse-public, not both.'
  }
  if (options.recipeJson && options.noPairing) {
    return 'Recipe JSON output requires runtime pairing; remove --no-pairing.'
  }
  if (options.recipeJson && options.mobilePairing) {
    return 'Recipe JSON output requires runtime pairing; remove --mobile-pairing.'
  }
  if (options.recipeJson && !options.projectRoot) {
    return 'Recipe JSON output requires --project-root.'
  }
  return null
}

const SERVE_SECURITY_FLAG_NAMES = [
  '--no-pairing',
  '--serve-no-pairing',
  '--mobile-pairing',
  '--serve-mobile-pairing',
  '--grant-desktop-control',
  '--serve-grant-desktop-control',
  '--recipe-json',
  '--serve-recipe-json',
  '--pairing-address',
  '--serve-pairing-address',
  '--bind',
  '--serve-bind',
  '--allow-public',
  '--serve-allow-public',
  '--refuse-public',
  '--serve-refuse-public'
] as const

const SERVE_VALUE_FLAG_NAMES = new Set([
  '--port',
  '--serve-port',
  '--bind',
  '--serve-bind',
  '--pairing-address',
  '--serve-pairing-address',
  '--project-root',
  '--serve-project-root',
  '--pairing-code',
  '--environment'
])

function flagName(token: string): string {
  const equalsIndex = token.indexOf('=')
  return equalsIndex === -1 ? token : token.slice(0, equalsIndex)
}

/** Reject only near-miss pairing flags; Electron/Chromium switches stay open-ended. */
export function getServeFlagTypoError(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === '--') {
      break
    }
    if (!token.startsWith('--')) {
      continue
    }
    const name = flagName(token)
    let suggestion: string | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const candidate of SERVE_SECURITY_FLAG_NAMES) {
      const distance = levenshtein(name, candidate)
      const maxDistance = candidate.startsWith(name) ? 3 : 2
      if (distance > 0 && distance <= maxDistance && distance < bestDistance) {
        suggestion = candidate
        bestDistance = distance
      }
    }
    if (suggestion) {
      return `Unknown flag ${name}. Did you mean ${suggestion}?`
    }

    // Non-flags belong to known value flags; use = for values starting -- to match parseArgs.
    if (!token.includes('=') && SERVE_VALUE_FLAG_NAMES.has(name)) {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('--')) {
        index += 1
      }
    }
  }
  return null
}
