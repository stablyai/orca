import type { useAppStore } from '@/store'
import type { AgentCompletionCoordinator } from '@/components/terminal-pane/agent-completion/agent-completion-coordinator-types'

export type CoordinatorEntry = {
  worktreeId: string
  ptyId: string | null
  coordinator: AgentCompletionCoordinator
}

export type StoreSnapshot = ReturnType<typeof useAppStore.getState>
export type PaneCoordinatorLivenessSnapshot = Pick<
  StoreSnapshot,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'terminalLayoutsByTabId' | 'suppressedPtyExitIds'
>
