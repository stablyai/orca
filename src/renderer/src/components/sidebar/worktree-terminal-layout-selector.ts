import { createWorktreeRecordSelector } from '@/store/worktree-record-selector-cache'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { AppState } from '@/store/types'
const EMPTY_RECORD = {}
export const EMPTY_TERMINAL_LAYOUTS: Record<string, TerminalLayoutSnapshot | undefined> =
  Object.freeze({})

export const selectTerminalLayoutsForWorktree = createWorktreeRecordSelector<
  Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>,
  Record<string, TerminalLayoutSnapshot | undefined>
>({
  readSources: (state) => [
    state.tabsByWorktree ?? EMPTY_RECORD,
    state.terminalLayoutsByTabId ?? EMPTY_RECORD
  ],
  empty: EMPTY_TERMINAL_LAYOUTS,
  build: (state, worktreeId) => {
    const out: Record<string, TerminalLayoutSnapshot | undefined> = {}
    for (const tab of (state.tabsByWorktree ?? EMPTY_RECORD)[worktreeId] ?? []) {
      out[tab.id] = (state.terminalLayoutsByTabId ?? EMPTY_RECORD)[tab.id]
    }
    return out
  }
})
