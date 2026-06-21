import React, { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { reopenChatConversation } from '@/lib/launch-chat-agent-tab'
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
    return 'just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  return `${days}d ago`
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

  if (chats.length === 0) {
    return null
  }

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
      aria-label="jcode chats"
      data-jcode-chats-list="true"
    >
      <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        jcode 聊天
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
            aria-label="Delete chat"
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
