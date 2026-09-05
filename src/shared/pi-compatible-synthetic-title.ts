export type PiCompatibleSyntheticAgentLabel = 'Pi' | 'OMP'
export type PiCompatibleSyntheticAgentStatus = 'working' | 'permission' | 'idle'

const PI_COMPATIBLE_SYNTHETIC_TITLE_RE =
  /^\s*(?:[\u2800-\u28ff]\s+)?(pi|omp)(?:\s+-\s+action required|\s+(?:ready|idle|done))?\s*$/i
// Why: legacy Pi/OMP-compatible shells can emit the delimiter before cwd text exists.
const LEGACY_PI_COMPATIBLE_TITLE_RE = /^\s*(?:[\u2800-\u28ff]\s+)?π(?:\s*[-:]|\s)\s*.*$/u
// Why: the state separator sits directly after the brand — `π ! label`, `OMP > label`. The brand
// may already have been swapped for the owner's label, so accept those too — but only in their
// exact profile casing, since a lowercase `pi - refactor…` is ordinary prose, not a Pi title.
// The separator must be delimited (`:` attached, or spaced) or `omp-harness` reads as a state.
// Why: OMP 17.2.12+ emits `π : <label>` on WSL/ConPTY; owner rewrite swaps the brand to
// `OMP : <label>`, so the spaced colon must classify as working here too (#17690).
const PI_COMPATIBLE_SEPARATOR_RE = /^\s*(?:π|Pi|OMP)(?::|\s+([!>:-]))(?=\s|$)/u
const PI_COMPATIBLE_PERMISSION_TAIL_RE = /\baction required\b/i

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
  // Why: bare "Pi"/"OMP" and ready/idle/done labels are all idle. Bare labels
  // come from normalizeTerminalTitle collapsing π frames; they must re-detect
  // as idle or stored lastOscTitle values classify as neutral after main-side
  // normalization.
  return 'idle'
}

export function isLegacyPiCompatibleTitle(title: string): boolean {
  return LEGACY_PI_COMPATIBLE_TITLE_RE.test(title)
}

/** Brand a Pi/OMP separator title carries, using the same grammar as status detection. */
export function getPiCompatibleTitleSeparatorBrand(
  title: string
): PiCompatibleSyntheticAgentLabel | null {
  if (containsBrailleSpinner(title)) {
    return null
  }
  if (!PI_COMPATIBLE_SEPARATOR_RE.exec(title)) {
    return null
  }
  const brandMatch = /^\s*(π|Pi|OMP)/u.exec(title)
  if (!brandMatch) {
    return null
  }
  return brandMatch[1] === 'OMP' ? 'OMP' : 'Pi'
}

/** Owner-rewritten titles that already use the ASCII Pi/OMP brand plus a state separator. */
export function isPiCompatibleAsciiSeparatorTitle(title: string): boolean {
  return (
    getPiCompatibleTitleSeparatorBrand(title) !== null && /^\s*(?:Pi|OMP)/u.test(title)
  )
}

/**
 * Reads the run state a π-branded title encodes in its separator.
 *
 * Why: Pi/OMP put the state between the brand and the session label —
 * `π ! <label>` means the agent is blocked on the user, `π > <label>` is the
 * user's turn, `π ⠋ <label>` is working (upstream `buildTerminalTitleWithState`).
 * Without this the `!` is never read and a blocked agent classifies as idle.
 */
export function getPiCompatibleTitleSeparatorStatus(
  title: string
): PiCompatibleSyntheticAgentStatus | null {
  // Why: a spinner anywhere means the agent is working, and that outranks the separator —
  // the frame is drawn over the idle separator position while a turn runs.
  if (containsBrailleSpinner(title)) {
    return null
  }
  const match = PI_COMPATIBLE_SEPARATOR_RE.exec(title)
  if (!match) {
    return null
  }
  // Why: `-` is both a state separator and the delimiter in the synthetic permission label, so
  // `OMP - action required` would read as idle. Callers happen to resolve that label earlier,
  // but this is exported — carry the guard here rather than depend on their ordering.
  if (PI_COMPATIBLE_PERMISSION_TAIL_RE.test(title)) {
    return 'permission'
  }
  if (match[1] === '!') {
    return 'permission'
  }
  if (match[1] === ':') {
    return 'working'
  }
  return 'idle'
}
