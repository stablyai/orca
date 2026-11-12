import type { useWorktreeAgentDisplay } from './use-worktree-agent-display'

import type { useWorktreeAgentExpansionState } from './worktree-card-agents-expansion-state'

export type SendTarget = { status: 'eligible' | 'disabled' | 'sending'; disabledReason?: string }

export type BranchContext = {
  worktreeId: string
  agentActivityDisplayMode: ReturnType<typeof useWorktreeAgentDisplay>['agentActivityDisplayMode']
  showAgentModels: boolean
  expansion: ReturnType<typeof useWorktreeAgentExpansionState>
  focusedPaneKey: string | null
  onActivate: (tabId: string, paneKey: string) => void
  onDismiss: (paneKey: string) => void
  targets: Map<string, SendTarget> | null
  onSend: (paneKey: string) => void
  toggleLineage: (paneKey: string) => void
  toggleIdle: (paneKey: string) => void
  now: number
}
