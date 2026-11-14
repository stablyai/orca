import type { useAppStore } from '@/store'
import type { AgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion/agent-completion-coordinator-types'

export type CoordinatorEntry = {
  worktreeId: string
  coordinator: AgentCompletionCoordinator
}

export type StoreSnapshot = ReturnType<typeof useAppStore.getState>
export type WorktreeTab = NonNullable<StoreSnapshot['tabsByWorktree']>[string][number]
// Index paneKey → tab once per prune instead of flattening all tabs per coordinator.
export type TabIndex = ReadonlyMap<string, WorktreeTab>
export type PaneCoordinatorLivenessSnapshot = Pick<
  StoreSnapshot,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'suppressedPtyExitIds'
>
