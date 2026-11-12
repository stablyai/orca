import type { TerminalNoticeLifetime } from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'
import { captureWorktreeTerminalNoticeRemoval } from '../../../terminals/terminal-notice-removal'
import type { TerminalTabRetirementState } from '../../../terminals/terminal-tab-retirement'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  captureWorkspaceChatDraftKeys,
  deleteWorkspaceChatDraftOwners,
  type WorkspaceChatDraftKeys
} from './removed-worktree-chat-drafts'

/** What the teardown needs from the worktree's tab lists, which a listing refresh started during
 *  the removal round trip can drop before the teardown runs. */
export type WorktreeStateBeforeRemoval = {
  readonly terminalNotices: readonly TerminalNoticeLifetime[]
  readonly terminalPtyIds: readonly string[]
  readonly chatDraftKeys: WorkspaceChatDraftKeys
}

export function captureWorktreeStateBeforeRemoval(
  state: TerminalTabRetirementState,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): WorktreeStateBeforeRemoval {
  return {
    terminalNotices: captureWorktreeTerminalNoticeRemoval(state, worktreeId),
    terminalPtyIds: (state.tabsByWorktree[worktreeId] ?? []).flatMap(
      (tab) => state.ptyIdsByTabId[tab.id] ?? []
    ),
    chatDraftKeys: captureWorkspaceChatDraftKeys(state, [
      { workspaceId: worktreeId, executionHostId }
    ])
  }
}

export function retireWorktreeDraftOwners(
  before: WorktreeStateBeforeRemoval
): WorktreeStateBeforeRemoval {
  deleteWorkspaceChatDraftOwners(before.chatDraftKeys)
  return before
}
