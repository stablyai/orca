import type { TerminalTabCloseExpectation } from '../../../../shared/terminal-tab-close'
import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { resolveTerminalCloseTarget } from './terminal-close-target'

function rendererBindingMatches(
  state: AppState,
  tabId: string,
  expected: TerminalTabCloseExpectation
): boolean {
  const target = resolveTerminalCloseTarget(state, tabId, undefined)
  const layout = target ? state.terminalLayoutsByTabId[target.terminalTabId] : null
  return layout?.ptyIdsByLeafId?.[expected.leafId] === expected.ptyId
}

export async function assertTerminalTabCloseExpectation(
  getState: () => AppState,
  tabId: string,
  expected: TerminalTabCloseExpectation
): Promise<void> {
  await callRuntimeRpc<{ verified: true }>(
    { kind: 'local' },
    'terminal.verifyTabCloseExpectation',
    expected,
    { suppressFeatureInteraction: true }
  )
  if (!rendererBindingMatches(getState(), tabId, expected)) {
    throw new Error('terminal_handle_stale')
  }
}
