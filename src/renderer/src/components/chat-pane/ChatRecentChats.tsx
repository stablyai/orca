import { useCallback, useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { reopenChatConversation } from '@/lib/launch-chat-agent-tab'
import {
  deleteChatConversation,
  listChatConversations
} from '@/components/chat-pane/chat-session-store'
import type { JcodeConversationSummary } from '../../../../shared/jcode-chat-types'

// Why (BUG 1/2, reopen): the empty state of a chat tab is a self-contained,
// chat-feature-owned place to surface "Recent chats" — durable conversations
// persisted to disk. Clicking one recreates its chat tab (reusing the stored
// sessionKey as the tab id) and rehydrates the transcript. This is intentionally
// NOT wired into orca's general PTY-agent sidebar (WorktreeCardAgents), which is
// a different system; see notImplemented in the handoff. Lives in its own file so
// ChatPane stays under the max-lines lint.
export function RecentChats({
  worktreeId,
  excludeSessionKey
}: {
  worktreeId?: string
  excludeSessionKey: string
}): React.JSX.Element | null {
  const [recents, setRecents] = useState<JcodeConversationSummary[]>([])

  const refresh = useCallback(() => {
    void listChatConversations().then((rows) =>
      setRecents(rows.filter((row) => row.sessionKey !== excludeSessionKey))
    )
  }, [excludeSessionKey])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (recents.length === 0) {
    return null
  }

  return (
    <div className="mt-6 w-full max-w-md text-left">
      <div className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {translate('jcode.chat.recents.heading', 'Recent chats')}
      </div>
      <div className="flex flex-col gap-1">
        {recents.slice(0, 8).map((row) => (
          <div
            key={row.sessionKey}
            className="group flex items-center gap-2 rounded-lg border border-border px-3 py-2 transition-colors hover:bg-muted"
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => {
                void reopenChatConversation({
                  conversation: row,
                  fallbackWorktreeId: worktreeId
                })
              }}
            >
              <div className="truncate text-sm text-foreground">{row.title}</div>
              <div className="text-xs text-muted-foreground">
                {new Date(row.updatedAt).toLocaleString()}
              </div>
            </button>
            <button
              type="button"
              aria-label={translate('jcode.chat.recents.deleteAria', 'Delete chat')}
              className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              onClick={() => {
                deleteChatConversation(row.sessionKey)
                refresh()
              }}
            >
              {translate('jcode.chat.recents.delete', 'Delete')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
