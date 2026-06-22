import React, { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { launchChatAgentTab, reopenChatConversation } from '@/lib/launch-chat-agent-tab'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  deleteChatConversation,
  listChatConversations,
  JCODE_CHAT_CONVERSATIONS_CHANGED_EVENT
} from '@/components/chat-pane/chat-session-store'
import type { JcodeConversationSummary } from '../../../../shared/jcode-chat-types'

/** Number of recent jcode chats shown per worktree card before truncating. */
const MAX_CHATS = 4

function formatTimeAgo(ts: number, now: number): string {
  const delta = now - ts
  if (delta < 60_000) {
    return translate('jcode.sidebar.chats.time.justNow', 'just now')
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return translate('jcode.sidebar.chats.time.minutesAgo', '{{value0}}m ago', {
      value0: minutes
    })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return translate('jcode.sidebar.chats.time.hoursAgo', '{{value0}}h ago', { value0: hours })
  }
  const days = Math.floor(hours / 24)
  return translate('jcode.sidebar.chats.time.daysAgo', '{{value0}}d ago', { value0: days })
}

type Props = {
  worktreeId: string
  className?: string
}

/**
 * Per-worktree "jcode chats" list rendered inline in the left project sidebar
 * under a worktree card. Distinct from WorktreeCardAgents (orca's PTY-agent
 * status rows): jcode chats are headless chat tabs persisted to disk by
 * jcode-conversation-store, never register a paneKey/agent-status, and so would
 * otherwise be invisible in the sidebar.
 *
 * Source: window.api.jcodeChat.listConversations() (via listChatConversations),
 * filtered to this worktree by the record's stored worktreeId. Clicking a row
 * goes through reopenChatConversation — the same path the in-pane RECENT CHATS
 * empty-state uses — so it recreates the chat tab (reusing the stored sessionKey
 * as the tab id) and rehydrates the transcript.
 *
 * Refresh: on mount and whenever a jcode turn boundary persists or a chat is
 * deleted (JCODE_CHAT_CONVERSATIONS_CHANGED_EVENT, best-effort DOM event).
 */
const WorktreeCardJcodeChats = React.memo(function WorktreeCardJcodeChats({
  worktreeId,
  className
}: Props) {
  const [chats, setChats] = useState<JcodeConversationSummary[]>([])

  const refresh = useCallback(() => {
    void listChatConversations().then((rows) => {
      setChats(rows.filter((row) => row.worktreeId === worktreeId))
    })
  }, [worktreeId])

  useEffect(() => {
    refresh()
    // Why: re-fetch on the best-effort change signal the chat store fires on
    // turn boundaries / deletes, so a finished chat appears without reopening
    // the sidebar. Falls back to the mount fetch when no events arrive.
    const onChanged = (): void => refresh()
    window.addEventListener(JCODE_CHAT_CONVERSATIONS_CHANGED_EVENT, onChanged)
    return () => {
      window.removeEventListener(JCODE_CHAT_CONVERSATIONS_CHANGED_EVENT, onChanged)
    }
  }, [refresh])

  // Start a NEW chat bound to THIS worktree. We activate the worktree FIRST
  // (setActiveWorktree sets activeWorktreeId + activeWorkspaceKey together, which
  // also resyncs them if a remote-project selection had left them split), so the
  // new chat tab is created in — and visible under — the right project. This is
  // the reliable, project-scoped creation path (mirrors how PTY agents launch
  // from their worktree row), unlike the global "+" which uses the active state.
  const startNewChat = useCallback(() => {
    activateAndRevealWorktree(worktreeId)
    launchChatAgentTab({ agent: 'jcode', worktreeId })
  }, [worktreeId])

  const now = Date.now()

  return (
    // Why: swallow bubbling so clicks on these rows don't reach WorktreeCard's
    // activate / edit-meta handlers, matching WorktreeCardAgents behavior.
    <div
      className={cn('flex flex-col mt-1 gap-0.5', className)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      role="group"
      aria-label={translate('jcode.sidebar.chats.groupAria', 'jcode chats')}
      data-jcode-chats-list="true"
    >
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {translate('jcode.sidebar.chats.heading', 'jcode chats')}
        </span>
        <button
          type="button"
          aria-label={translate('jcode.sidebar.chats.newChatAria', 'New jcode chat here')}
          title={translate('jcode.sidebar.chats.newChatTitle', 'New jcode chat here')}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-worktree-sidebar-accent hover:text-foreground"
          onClick={startNewChat}
        >
          <Plus className="size-3" />
        </button>
      </div>
      {chats.slice(0, MAX_CHATS).map((row) => (
        <div
          key={row.sessionKey}
          className="group/jcode-chat-row relative flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-worktree-sidebar-accent"
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => {
              void reopenChatConversation({
                conversation: row,
                fallbackWorktreeId: worktreeId
              })
            }}
          >
            <span className="shrink-0 text-[10px] leading-none text-muted-foreground">💬</span>
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">{row.title}</span>
            <span className="shrink-0 text-[10px] leading-none text-muted-foreground">
              {formatTimeAgo(row.updatedAt, now)}
            </span>
          </button>
          <button
            type="button"
            aria-label={translate('jcode.sidebar.chats.deleteAria', 'Delete chat')}
            className="shrink-0 rounded px-1 text-[10px] leading-none text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/jcode-chat-row:opacity-100"
            onClick={() => {
              deleteChatConversation(row.sessionKey)
              refresh()
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
})

export default WorktreeCardJcodeChats
