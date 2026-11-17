import { containsCsiRendererQuery } from '../../../../../../shared/terminal/protocol/queries/terminal-reply-query-extraction'
import { isKnownTuiAgentTerminalStartupCommand } from '../startup/terminal-startup-command-classifier'
import type { PtyConnectionDeps } from '../pty-connection-deps'

export function shouldKeepHiddenStartupRendererQueriesLive(
  startup: PtyConnectionDeps['startup']
): boolean {
  return (
    Boolean(startup?.telemetry?.agent_kind && startup.telemetry.agent_kind !== 'other') ||
    Boolean(startup?.agentLaunch) ||
    isKnownTuiAgentTerminalStartupCommand(startup?.command ?? '')
  )
}

export function containsHiddenStartupRendererQuery(data: string): boolean {
  // Hidden startup skips redraw floods but query chunks still need replies to unblock TUIs.
  return containsCsiRendererQuery(data) || data.includes('\x1b]10;?') || data.includes('\x1b]11;?')
}
