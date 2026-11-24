import { getPiStateTitleStatus } from './pi-state-title-marker'

export type PiCompatibleSyntheticAgentLabel = 'Pi' | 'OMP'
export type PiCompatibleSyntheticAgentStatus = 'working' | 'permission' | 'idle'

const PI_COMPATIBLE_SYNTHETIC_TITLE_RE =
  /^\s*(?:[\u2800-\u28ff]\s+)?(pi|omp)(?:\s+-\s+action required|\s+(?:ready|idle|done))?\s*$/i
// Why: legacy Pi/OMP-compatible shells can emit the delimiter before cwd text exists.
const LEGACY_PI_COMPATIBLE_TITLE_RE = /^\s*(?:[\u2800-\u28ff]\s+)?\u03C0(?:\s*[-:]|\s)\s*.*$/u
// State follows the brand (π ! label, OMP > label); accept owner-rewritten brands only in exact profile casing.
// Require a delimited separator so ordinary pi prose and omp-harness do not become state titles.
// A leading spinner needs Orca's ` - ` working frame, so Claude tasks like `⠂ OMP: fix` stay Claude's.
const PI_COMPATIBLE_SEPARATOR_RE =
  /^\s*(?:[\u2800-\u28ff]\s+(?=\S+\s+-(?:\s|$)))?(\u03C0|Pi|OMP)(?::|\s+([!>:\-\u2800-\u28ff]))(?=\s|$)/u

const PI_COMPATIBLE_LEADING_BRAND_RE = /^(\s*(?:[\u2800-\u28ff]\s+)?)(?:\u03C0|Pi|OMP)/u

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
  // Bare/ready labels come from frame normalization and must reclassify idle, including persisted lastOscTitle.
  return 'idle'
}

export function isLegacyPiCompatibleTitle(title: string): boolean {
  return LEGACY_PI_COMPATIBLE_TITLE_RE.test(title)
}

/** Read native separators: ! needs input, > is idle, braille is working (upstream buildTerminalTitleWithState). */
export function getPiCompatibleTitleSeparatorStatus(
  title: string
): PiCompatibleSyntheticAgentStatus | null {
  const nativeState = getPiStateTitleStatus(title)
  if (nativeState) {
    return nativeState
  }
  // Working braille replaces the idle separator and must outrank it.
  if (containsBrailleSpinner(title)) {
    return null
  }
  const match = PI_COMPATIBLE_SEPARATOR_RE.exec(title)
  if (!match) {
    return null
  }
  // The synthetic `OMP - action required` label also uses a hyphen; match only that label, never session text.
  if (getPiCompatibleSyntheticAgentStatus(title) === 'permission') {
    return 'permission'
  }
  return match[2] === '!' ? 'permission' : 'idle'
}

/** Brand a π/Pi/OMP title leads with, so owner-rebranded frames (`⠋ OMP - session - cwd`) keep their identity. */
export function getPiCompatibleTitleBrand(title: string): PiCompatibleSyntheticAgentLabel | null {
  const brand = PI_COMPATIBLE_SEPARATOR_RE.exec(title)?.[1]
  if (!brand) {
    return null
  }
  return brand === 'OMP' ? 'OMP' : 'Pi'
}

/** Replace the leading brand of a π/Pi/OMP title in place, or null when the title has none. */
export function rebrandPiCompatibleTitle(title: string, brand: string): string | null {
  if (!isLegacyPiCompatibleTitle(title) && !getPiCompatibleTitleBrand(title)) {
    return null
  }
  return title.replace(PI_COMPATIBLE_LEADING_BRAND_RE, (_, lead: string) => lead + brand)
}
