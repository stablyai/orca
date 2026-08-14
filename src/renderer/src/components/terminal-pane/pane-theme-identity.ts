import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import type { TuiAgent } from '../../../../shared/types'
import { resolvePaneKeyboardProtocolAgent } from './terminal-keyboard-protocol-pane-agent'

/** Immutable per-leaf theme agent. Captured once; deleted only on close/detach. */
const paneThemeAgents = new Map<TerminalLeafId, TuiAgent | null>()

export function capturePaneThemeAgent(
  leafId: TerminalLeafId,
  startup: { launchAgent?: TuiAgent } | null | undefined,
  tabLaunchAgent?: TuiAgent | null
): TuiAgent | null {
  if (paneThemeAgents.has(leafId)) {
    return paneThemeAgents.get(leafId) ?? null
  }
  const agent = resolvePaneKeyboardProtocolAgent(startup, tabLaunchAgent)
  paneThemeAgents.set(leafId, agent)
  return agent
}

export function getPaneThemeAgent(leafId: TerminalLeafId | null | undefined): TuiAgent | null {
  if (!leafId || !paneThemeAgents.has(leafId)) {
    return null
  }
  return paneThemeAgents.get(leafId) ?? null
}

export function releasePaneThemeAgent(leafId: TerminalLeafId): void {
  paneThemeAgents.delete(leafId)
}

export function _resetPaneThemeIdentityForTest(): void {
  paneThemeAgents.clear()
}
