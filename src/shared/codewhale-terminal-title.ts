import { titleHasAgentName } from './agent-name-token-match'
import { getWrapperTitleSegments } from './terminal-title-wrapper-segments'

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

const WHALE_ACTIVITY_TITLE_RE = new RegExp(
  `^(?:\\[[^\\]]*\\]\\s*)?(?:${CODEWHALE_STATIC_WHALE}|${CODEWHALE_ANIMATED_WHALE})\\s+(?:${ACTIVITY_VERBS.map(
    (verb) => verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ).join('|')})$`
)

/** Why segments: a multiplexer prefixes the pane's own title (`zsh | 🐳 working…`). */
export function isCodewhaleTerminalTitle(title: string): boolean {
  return getWrapperTitleSegments(title.trim()).some(
    (segment) => titleHasAgentName(segment, 'codewhale') || WHALE_ACTIVITY_TITLE_RE.test(segment)
  )
}
