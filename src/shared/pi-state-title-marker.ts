import type { AgentStatus } from './agent-title-core'

/**
 * Markers Pi/OMP write between the `π` prefix and their label to encode turn state
 * (`π : cwd` working, `π > cwd` idle, `π ! cwd` needs input).
 *
 * Kept as a table because upstream re-punctuates this channel between releases: OMP
 * 17.2.12 replaced its animated braille frames with these static markers on WSL/ConPTY,
 * where the console host cannot repaint fast enough to animate (#13890, #8014). Every
 * consumer — status detection, the display-title normalizer, and the stale-title clear —
 * reads this one table, so teaching Orca a later protocol is a row, not a reparse.
 */
const PI_STATE_MARKER_STATUS = {
  ':': 'working',
  '!': 'permission',
  '>': 'idle'
} as const satisfies Record<string, AgentStatus>

export type PiStateMarker = keyof typeof PI_STATE_MARKER_STATUS

export const PI_STATE_MARKERS = Object.keys(PI_STATE_MARKER_STATUS) as PiStateMarker[]

/** Marker a stale working title is rewritten to; see {@link clearPiStateWorkingMarker}. */
const PI_IDLE_MARKER = '>' satisfies PiStateMarker

function escapeForCharacterClass(marker: string): string {
  return marker.replace(/[\\\]^-]/g, '\\$&')
}

// Why: `π` must sit at a token boundary so wrapper prefixes of any shape (`zsh | π : cwd`,
// `tmux: π : cwd`) still expose the marker, and whitespace must separate the marker so the
// legacy no-space `π: cwd` disabled title keeps its historical idle classification.
const PI_STATE_TITLE_RE = new RegExp(
  `(?:^|[\\s|])π[ \\t]+([${PI_STATE_MARKERS.map(escapeForCharacterClass).join('')}])(?=\\s|$)`,
  'u'
)

type PiStateTitleMatch = {
  marker: PiStateMarker
  markerIndex: number
}

/**
 * Leftmost marker wins: everything after it is Pi/OMP's own label, which legally contains
 * the wrapper separator and marker-shaped punctuation of its own (`π > release | π : note`).
 */
function matchPiStateTitle(title: string): PiStateTitleMatch | null {
  const match = PI_STATE_TITLE_RE.exec(title)
  if (!match) {
    return null
  }
  return {
    marker: match[1] as PiStateMarker,
    markerIndex: match.index + match[0].length - 1
  }
}

/** Status a Pi/OMP native state title asserts, or null when the title carries no marker. */
export function getPiStateTitleStatus(title: string): AgentStatus | null {
  const match = matchPiStateTitle(title)
  return match ? PI_STATE_MARKER_STATUS[match.marker] : null
}

/**
 * Rewrite a working marker to the idle marker so a title left behind by an agent that
 * stopped emitting stops reporting working. Returns null when there is nothing to clear —
 * the caller's other strip passes still apply.
 */
export function clearPiStateWorkingMarker(title: string): string | null {
  const match = matchPiStateTitle(title)
  if (!match || PI_STATE_MARKER_STATUS[match.marker] !== 'working') {
    return null
  }
  return `${title.slice(0, match.markerIndex)}${PI_IDLE_MARKER}${title.slice(match.markerIndex + 1)}`
}
