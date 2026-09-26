import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'

// The TUI status line reads `<model> · <effort> · <cwd> · <mode>`, e.g.
// `muse-spark-1.3-contributor · max · ~/Development/GitHub/orca · YOLO0`.
// The effort slot carries the raw `--reasoning-effort` id, including `none`
// (which the picker omits for lack of a translation but the pill renders raw).
const MUSE_STATUS_LINE =
  /^\s*(\S+)\s*·\s*(none|minimal|low|medium|high|xhigh|max|ultra)\s*·\s*(.+?)\s*·\s*(\S+)\s*$/

/**
 * Current Muse model/effort scraped from the TUI status line. The model id is
 * reported raw: account-scoped ids have no catalog listing, so there is no
 * picker, but the pill still names what the session runs.
 */
export function readMuseSessionOptionsFromTerminalScreen(
  screen: string | null | undefined
): Record<string, SessionOptionValue> | null {
  if (!screen) {
    return null
  }
  const lines = stripAnsiEscapeSequences(screen).split('\n')
  // Why: the status line sits at the bottom; scanning upward takes it before
  // any user text that happens to share the four-segment shape.
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = lines[index].match(MUSE_STATUS_LINE)
    if (match) {
      return { model: match[1], effort: match[2] }
    }
  }
  return null
}
