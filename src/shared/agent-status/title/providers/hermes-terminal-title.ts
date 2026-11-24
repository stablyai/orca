import type { AgentStatus } from '../agent-title-core'
import type { TerminalAgent } from '../../identity/terminal-agent'

// Hermes TUI titles lead with ⚠ (approval or question), ⏳ (busy) or ✓ (idle), then the session name.
const HERMES_TITLE_MARKER_STATUS: Record<string, AgentStatus> = {
  '\u2713': 'idle',
  '\u23F3': 'working',
  '\u26A0': 'permission'
}

/** The markers are too generic to identify Hermes, so they count only in a Hermes pane. */
export function hermesNativeTitleStatus(
  title: string,
  agent: TerminalAgent | null
): AgentStatus | null {
  if (agent !== 'hermes') {
    return null
  }
  const marker = title.match(/^(\u2713|\u23F3|\u26A0)\uFE0F?(?:\s|$)/u)?.[1]
  return marker ? HERMES_TITLE_MARKER_STATUS[marker] : null
}
