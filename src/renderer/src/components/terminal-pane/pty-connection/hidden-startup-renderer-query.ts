import { containsCsiRendererQuery } from '../../../../../shared/terminal-reply-query-extraction'
import { isKnownTuiAgentTerminalStartupCommand } from '../terminal-startup-command-classifier'
import type { PtyConnectionDeps } from '../pty-connection-types'

export function shouldKeepHiddenStartupRendererQueriesLive(
  startup: PtyConnectionDeps['startup']
): boolean {
  return (
    Boolean(startup?.telemetry?.agent_kind && startup.telemetry.agent_kind !== 'other') ||
    isKnownTuiAgentTerminalStartupCommand(startup?.command ?? '')
  )
}

export function containsHiddenStartupRendererQuery(data: string): boolean {
  // Why: hidden Codex startup must not live-render ordinary redraw floods, but
  // query chunks still need xterm's built-in terminal replies to unblock TUIs.
  return containsCsiRendererQuery(data) || data.includes('\x1b]10;?') || data.includes('\x1b]11;?')
}
