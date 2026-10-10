import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { CreatedAgentTerminalIdentity } from './web-runtime-session-types'

export function createdTerminalLeafId(terminal: CreatedAgentTerminalIdentity): string | undefined {
  const pane = parsePaneKey(terminal.paneKey ?? '')
  return pane && pane.tabId === terminal.tabId ? pane.leafId : undefined
}

/** Decode only the host terminal coordinates consumed by the paired renderer. */
export function readCreatedAgentTerminalIdentity(value: unknown): {
  terminal: CreatedAgentTerminalIdentity
} {
  if (typeof value !== 'object' || value === null || !('terminal' in value)) {
    throw new Error('Host returned an invalid agent terminal result')
  }
  const terminal = value.terminal
  if (typeof terminal !== 'object' || terminal === null) {
    throw new Error('Host returned an invalid agent terminal identity')
  }
  const tabId = 'tabId' in terminal ? terminal.tabId : undefined
  const paneKey = 'paneKey' in terminal ? terminal.paneKey : undefined
  if (
    (tabId !== undefined && typeof tabId !== 'string') ||
    (paneKey !== undefined && paneKey !== null && typeof paneKey !== 'string')
  ) {
    throw new Error('Host returned invalid agent terminal coordinates')
  }
  return { terminal: { tabId, paneKey } }
}
