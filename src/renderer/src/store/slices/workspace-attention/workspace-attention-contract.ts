import type { StateCreator } from 'zustand'
import type { StoredAgentAttentionUnread } from '@/attention/agent-attention-contract'
import type { AgentAttentionUnreadWrite } from '@/attention/agent-attention-policy'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { AppState } from '../../types'

export type WorkspaceAttentionSet = Parameters<StateCreator<AppState>>[0]
export type WorkspaceAttentionGet = Parameters<StateCreator<AppState>>[1]

export type OnScreenAttentionTarget = { worktreeId: string | null; tabId: string }

/** What a visible, focused window shows: its workspaces (main and floating) and their tabs. */
export type OnScreenAttention = {
  workspaceIds: readonly string[]
  targets: readonly OnScreenAttentionTarget[]
}

export type TerminalPaneAttentionTarget = {
  worktreeId: string
  tabId: string
  paneKey: string
}

/** The unread records and every transition on them; in-`set()` ones live in `subject-attention-transitions.ts`. */
export type WorkspaceAttentionSlice = {
  /** Tab marker, keyed by terminal tab id or a structured chat's unified tab id. Renderer-local. */
  unreadTerminalTabs: Record<string, StoredAgentAttentionUnread>
  /** Experimental per-pane marker (bells and completions), keyed by pane key. Renderer-local. */
  unreadTerminalPanes: Record<string, StoredAgentAttentionUnread>
  /** Agent completion awaiting acknowledgement, keyed by pane key. Renderer-local. */
  unreadAgentCompletionPanes: Record<string, StoredAgentAttentionUnread>
  /** A BEL arrived from a pane's PTY, mounted or parked. */
  markTerminalBell: (target: TerminalPaneAttentionTarget) => void
  /** An admitted, unviewed agent completion or prompt (terminal or structured chat). */
  markAgentAttentionUnread: (write: AgentAttentionUnreadWrite) => void
  /**
   * The tabs on screen in a visible, focused window with the user present are read — every
   * marker of each. `screenArrived` is true when the set of on-screen tabs (or the on-screen
   * workspace, host or window focus) changed since the last read; a tab switch counts. Then each
   * on-screen workspace's flag is settled even when nothing was removed.
   */
  readOnScreenAttention: (screen: OnScreenAttention, options: { screenArrived: boolean }) => void
  /** Sidebar "Mark as read" (also removes every marker in the workspace) / "Mark as unread". */
  setWorkspaceUnreadByUser: (
    worktreeId: string,
    isUnread: boolean,
    executionHostId: ExecutionHostId
  ) => void
}
