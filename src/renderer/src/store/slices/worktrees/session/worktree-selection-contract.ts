import type { AppState } from '../../../types'

export type WorktreeRenameRequest = {
  worktreeId: string
  rowKey?: string
}

export type ActiveWorktreeStateTransition = (state: AppState) => {
  patch: Partial<AppState>
  activate: boolean
  preferredActiveUnifiedTabId?: string
}
