import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

export type RecentlyClosedTabKind = 'terminal' | 'browser' | 'editor' | 'chat'

export type ClosedChatTabSnapshot = {
  /** Provider conversation ID (Claude session / Codex thread), not the Orca tab session ID. */
  providerSessionId: string
  agent: TuiAgent
  executionHostId: ExecutionHostId
  customTitle?: string
}

const MAX_RECENT_CLOSED_CHAT_TABS = 10

export function pushClosedChatTabSnapshot(
  map: Record<string, ClosedChatTabSnapshot[]> | undefined,
  worktreeId: string,
  snapshot: ClosedChatTabSnapshot
): Record<string, ClosedChatTabSnapshot[]> {
  return {
    ...map,
    [worktreeId]: [snapshot, ...(map?.[worktreeId] ?? [])].slice(0, MAX_RECENT_CLOSED_CHAT_TABS)
  }
}

// Cross-type history exceeds per-type cap 10; drained snapshot kinds are skipped on pop.
const MAX_RECENT_CLOSED_TAB_KINDS = 30

export function pushRecentlyClosedTabKind(
  map: Record<string, RecentlyClosedTabKind[]> | undefined,
  worktreeId: string,
  kind: RecentlyClosedTabKind,
  count = 1
): Record<string, RecentlyClosedTabKind[]> {
  // No-op pushes preserve identity for unrelated subscribers, like closeTab unread maps.
  if (count <= 0) {
    return map ?? {}
  }
  // Thousands of close-all entries beyond history cap cannot affect reopen order.
  const retainedCount = Math.min(count, MAX_RECENT_CLOSED_TAB_KINDS)
  return {
    ...map,
    [worktreeId]: [
      ...(Array(retainedCount).fill(kind) as RecentlyClosedTabKind[]),
      ...(map?.[worktreeId] ?? [])
    ].slice(0, MAX_RECENT_CLOSED_TAB_KINDS)
  }
}

export type RecentlyClosedTabsSlice = {
  /** Newest-first close order across the terminal/browser/editor/chat reopen stacks
   *  so Cmd+Shift+T pops true cross-type MRU (Chrome/Ghostty semantics). */
  recentlyClosedTabKindsByWorktree: Record<string, RecentlyClosedTabKind[]>
  /** Newest-first identity of a closed chat, enough to resume the same conversation. */
  recentlyClosedChatTabsByWorktree: Record<string, ClosedChatTabSnapshot[]>
  reopenClosedTab: (worktreeId: string) => boolean
  reopenClosedChatTab: (worktreeId: string) => boolean
}

export const createRecentlyClosedTabsSlice: StateCreator<
  AppState,
  [],
  [],
  RecentlyClosedTabsSlice
> = (set, get) => ({
  recentlyClosedTabKindsByWorktree: {},
  recentlyClosedChatTabsByWorktree: {},

  reopenClosedChatTab: (worktreeId) => {
    let snapshot: ClosedChatTabSnapshot | undefined
    set((s) => {
      const stack = s.recentlyClosedChatTabsByWorktree[worktreeId] ?? []
      snapshot = stack[0]
      if (!snapshot) {
        return s
      }
      return {
        recentlyClosedChatTabsByWorktree: {
          ...s.recentlyClosedChatTabsByWorktree,
          [worktreeId]: stack.slice(1)
        }
      }
    })
    if (!snapshot) {
      return false
    }
    const closed = snapshot
    void import('@/lib/agent-session/resume/reopen-closed-chat')
      .then(({ resumeClosedChatTab }) =>
        resumeClosedChatTab(closed, worktreeId, () => get().reopenClosedTab(worktreeId))
      )
      .catch(() => get().reopenClosedTab(worktreeId))
    return true
  },

  reopenClosedTab: (worktreeId) => {
    // Kind entries can outlive tighter/deduped snapshots; skip drained kinds, bounded by one shift per entry.
    for (;;) {
      let kind: RecentlyClosedTabKind | undefined
      set((s) => {
        const kinds = s.recentlyClosedTabKindsByWorktree[worktreeId] ?? []
        kind = kinds[0]
        if (!kind) {
          return s
        }
        return {
          recentlyClosedTabKindsByWorktree: {
            ...s.recentlyClosedTabKindsByWorktree,
            [worktreeId]: kinds.slice(1)
          }
        }
      })
      if (!kind) {
        return false
      }
      const reopened =
        kind === 'terminal'
          ? get().reopenClosedTerminalTab(worktreeId)
          : kind === 'browser'
            ? get().reopenClosedBrowserTab(worktreeId) !== null
            : kind === 'chat'
              ? get().reopenClosedChatTab(worktreeId)
              : get().reopenClosedEditorTab(worktreeId)
      if (reopened) {
        return true
      }
    }
  }
})
