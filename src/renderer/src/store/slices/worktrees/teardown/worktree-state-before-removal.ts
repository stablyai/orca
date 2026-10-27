import type { AppState } from '../../../types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  captureWorkspaceChatDraftKeys,
  type WorkspaceChatDraftKeys
} from './removed-worktree-chat-drafts'

/** What the teardown needs from the worktree's tab lists, which a listing refresh started during
 *  the removal round trip can drop before the teardown runs. */
export type WorktreeStateBeforeRemoval = {
  readonly terminalPtyIds: readonly string[]
  readonly chatDraftKeys: WorkspaceChatDraftKeys
}

export function captureWorktreeStateBeforeRemoval(
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree' | 'ptyIdsByTabId'>,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): WorktreeStateBeforeRemoval {
  return {
    terminalPtyIds: (state.tabsByWorktree[worktreeId] ?? []).flatMap(
      (tab) => state.ptyIdsByTabId[tab.id] ?? []
    ),
    chatDraftKeys: captureWorkspaceChatDraftKeys(state, [
      { workspaceId: worktreeId, executionHostId }
    ])
  }
}
