import { isTerminalLeafId } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { AppState } from '@/store/types'

export type LocatedCodexPane = {
  worktreeId: string
  tab: TerminalTab
  leafId: string | null
  generation: number
}

export function locateCodexPane(state: AppState, ptyId: string): LocatedCodexPane | null {
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.ptyId !== ptyId && !(state.ptyIdsByTabId[tab.id] ?? []).includes(ptyId)) {
        continue
      }
      const leafId =
        Object.entries(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}).find(
          ([, boundPtyId]) => boundPtyId === ptyId
        )?.[0] ?? null
      // Reject legacy numeric leaves because pane-key environment and main binding require UUIDs.
      return {
        worktreeId,
        tab,
        leafId: leafId !== null && isTerminalLeafId(leafId) ? leafId : null,
        generation: tab.generation ?? 0
      }
    }
  }
  return null
}
