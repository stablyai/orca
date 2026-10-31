import {
  getWrapperTitleSegments,
  isNeutralAgentTitleWrapper,
  WRAPPER_SEPARATOR
} from './terminal-title-wrapper-segments'

/** Codewhale's static OSC-0 whale (focused, or motion disabled). */
export const CODEWHALE_STATIC_WHALE = '\u{1F433}' // 🐳
/** Codewhale's unfocused animation alternate; DSH also uses this whale. */
const CODEWHALE_ANIMATED_WHALE = '\u{1F40B}' // 🐋

// Why: while working Codewhale replaces its name with `<whale> <verb>`, and the
// verbs come from one closed list in crates/tui/src/tui/underwater.rs.
const ACTIVITY_VERBS = [
  'waiting on you…',
  'verifying…',
  'done',
  'failed',
  'drafting…',
  'idle',
  'compacting context…',
  'reasoning…',
  'reading…',
  'using tool…',
  'fleet underway…',
  'working…',
  'in the current…'
]

// Why: `/title` puts `[prefix] ` in front of every window title Codewhale paints.
const TITLE_PREFIX = '(?:\\[[^\\]]*\\]\\s*)?'
const NAME_TITLE_RE = new RegExp(`^${TITLE_PREFIX}codewhale(?:\\.(?:exe|cmd|bat|ps1))?$`, 'i')
const WHALE_ACTIVITY_TITLE_RE = new RegExp(
  `^${TITLE_PREFIX}(?:${CODEWHALE_STATIC_WHALE}|${CODEWHALE_ANIMATED_WHALE})\\s+(?:${ACTIVITY_VERBS.map(
    (verb) => verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('|')})$`
)

function isCodewhaleFrame(segment: string): boolean {
  return NAME_TITLE_RE.test(segment.trim()) || WHALE_ACTIVITY_TITLE_RE.test(segment)
}

/** Why neutral: a shell prefix may wrap the frame, but after a DSH session or task header the pipe is payload. */
function hasOnlyWrapperHeaders(prefix: string): boolean {
  return prefix
    .split(WRAPPER_SEPARATOR)
    .every(
      (header) =>
        isNeutralAgentTitleWrapper(header) &&
        !header.includes(CODEWHALE_STATIC_WHALE) &&
        !header.includes(CODEWHALE_ANIMATED_WHALE)
    )
}

/** Why segments: a multiplexer prefixes the pane's own title (`zsh | 🐳 working…`). */
export function isCodewhaleTerminalTitle(title: string): boolean {
  const trimmed = title.trim()
  return getWrapperTitleSegments(trimmed).some(
    (segment) =>
      isCodewhaleFrame(segment) &&
      hasOnlyWrapperHeaders(trimmed.slice(0, trimmed.length - segment.length))
  )
}
