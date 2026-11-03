import type { AppState } from '@/store'

/** PTYs whose queued account restart this tab runs: any Codex at once, and this tab's own Claude panes. */
export function selectReadyAccountRestartPtyIds(state: AppState, tabId: string): string[] {
  const pending = state.pendingPaneAccountRestarts
  const ready = Object.keys(pending).filter((ptyId) => pending[ptyId] === 'codex')
  const ptyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  for (const ptyId of Object.values(ptyIdsByLeafId)) {
    if (pending[ptyId] === 'claude') {
      ready.push(ptyId)
    }
  }
  return ready
}
