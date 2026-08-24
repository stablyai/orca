import { getWrapperTitleSegments } from './terminal-title-wrapper-segments'

export type PiCompatibleSyntheticAgentLabel = 'Pi' | 'OMP'
export type PiCompatibleSyntheticAgentStatus = 'working' | 'permission' | 'idle'

const PI_COMPATIBLE_SYNTHETIC_TITLE_RE =
  /^\s*(?:[\u2800-\u28ff]\s+)?(pi|omp)(?:\s+-\s+action required|\s+(?:ready|idle|done))?\s*$/i
// Why: legacy Pi/OMP-compatible shells can emit the delimiter before cwd text exists.
const LEGACY_PI_COMPATIBLE_TITLE_RE = /^\s*(?:[\u2800-\u28ff]\s+)?π(?:\s*[-:]|\s)\s*.*$/u
// OMP 17.2.12+ uses static state delimiters on WSL/ConPTY instead of braille frames.
// Require whitespace before the delimiter so the legacy disabled title `π: cwd` stays idle.
const PI_COMPATIBLE_NATIVE_STATE_TITLE_RE = /^\s*π\s+([:>!])(?:\s+.*)?$/u

function containsBrailleSpinner(title: string): boolean {
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && codePoint >= 0x2800 && codePoint <= 0x28ff) {
      return true
    }
  }
  return false
}

export function getPiCompatibleSyntheticAgentLabel(
  title: string
): PiCompatibleSyntheticAgentLabel | null {
  const match = PI_COMPATIBLE_SYNTHETIC_TITLE_RE.exec(title)
  if (!match) {
    return null
  }
  return match[1].toLowerCase() === 'omp' ? 'OMP' : 'Pi'
}
/**
 * Classify OMP's native π state-title protocol, including wrapper-prefixed titles.
 * Whitespace before the delimiter keeps the legacy disabled `π: cwd` title idle.
 */
export function getPiCompatibleNativeTitleStatus(
  title: string
): PiCompatibleSyntheticAgentStatus | null {
  for (const segment of getWrapperTitleSegments(title)) {
    const stateDelimiter = PI_COMPATIBLE_NATIVE_STATE_TITLE_RE.exec(segment)?.[1]
    if (stateDelimiter === ':') {
      return 'working'
    }
    if (stateDelimiter === '!') {
      return 'permission'
    }
    if (stateDelimiter === '>') {
      return 'idle'
    }
  }
  return null
}

export function getPiCompatibleSyntheticAgentStatus(
  title: string
): PiCompatibleSyntheticAgentStatus | null {
  if (!getPiCompatibleSyntheticAgentLabel(title)) {
    return null
  }
  if (containsBrailleSpinner(title)) {
    return 'working'
  }
  const lower = title.toLowerCase()
  if (
    lower.includes('action required') ||
    lower.includes('permission') ||
    lower.includes('waiting')
  ) {
    return 'permission'
  }
  // Why: bare "Pi"/"OMP" and ready/idle/done labels are all idle. Bare labels
  // come from normalizeTerminalTitle collapsing π frames; they must re-detect
  // as idle or stored lastOscTitle values classify as neutral after main-side
  // normalization.
  return 'idle'
}

export function isLegacyPiCompatibleTitle(title: string): boolean {
  return LEGACY_PI_COMPATIBLE_TITLE_RE.test(title)
}
