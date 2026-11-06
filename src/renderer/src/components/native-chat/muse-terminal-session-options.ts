import type { SessionOptionValue } from '../../../../shared/native-chat/input/native-chat-session-options'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

// Muse's footer reads `<model> · <effort> · <cwd> · <permission profile>`,
// e.g. `muse-spark-1.3 · high · /tmp/repo · Auto-review`.
const MUSE_STATUS_LINE =
  /^\s*(\S+)\s+·\s+(none|minimal|low|medium|high|xhigh|max|ultra)\s+·\s+\S.*·\s+\S.*$/

/** Current model and effort from the Muse TUI footer; bottom-up so the live footer wins over scrollback. */
export function readMuseSessionOptionsFromTerminalScreen(
  screen: string | null | undefined
): Record<string, SessionOptionValue> | null {
  if (!screen) {
    return null
  }
  const lines = stripScrollbackAnsi(screen).split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const [, model, effort] = MUSE_STATUS_LINE.exec(lines[index] ?? '') ?? []
    if (model && effort) {
      return { model, effort }
    }
  }
  return null
}
