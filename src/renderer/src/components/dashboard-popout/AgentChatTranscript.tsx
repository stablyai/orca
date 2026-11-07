import { useEffect, useRef } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { StructuredAgentSessionState } from '../../../../shared/agent-session/structured-agent-session-reducer'
import { MessageRow } from '../native-chat/messages/rows/NativeChatMessageRow'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'

/** Preserve reading position when history is prepended; follow new messages only while the reader stays near the bottom. */
export function AgentChatTranscript({
  messages,
  agentName,
  status,
  current,
  hasOlder,
  loadingOlder,
  loadOlder,
  className
}: {
  messages: NativeChatMessage[]
  agentName: string
  status: StructuredAgentSessionState['status']
  current: boolean
  hasOlder: boolean
  loadingOlder: boolean
  loadOlder: () => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const viewport = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const olderHeight = useRef<number | null>(null)
  useEffect(() => {
    const element = viewport.current
    if (!element) {
      return
    }
    if (olderHeight.current !== null && !loadingOlder) {
      element.scrollTop += element.scrollHeight - olderHeight.current
      olderHeight.current = null
    } else if (follow.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [messages, loadingOlder])
  return (
    <div className={cn('native-chat-appearance flex min-h-0 flex-1 flex-col', className)}>
      {!current && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
          {status === 'error'
            ? t(
                'dashboardPopout.chat.readFailed',
                'Unable to load this chat. Open the workspace to reconnect.'
              )
            : t('dashboardPopout.chat.connecting', 'Connecting to chat…')}
        </p>
      )}
      <div
        ref={viewport}
        className="scrollbar-sleek min-h-0 flex-1 overflow-auto px-3"
        onScroll={() => {
          const element = viewport.current
          if (element) {
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
          }
        }}
      >
        {hasOlder && (
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingOlder || !current}
            onClick={() => {
              follow.current = false
              olderHeight.current = viewport.current?.scrollHeight ?? null
              loadOlder()
            }}
          >
            {t('dashboardPopout.chat.loadOlder', 'Load earlier messages')}
          </Button>
        )}
        {current && messages.length === 0 && (
          <p className="py-3 text-sm text-muted-foreground">
            {t('dashboardPopout.chat.empty', 'No messages in this chat yet.')}
          </p>
        )}
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            agentName={agentName}
            expandSignal={false}
            onScrollMessageToTop={(element) => element.scrollIntoView({ block: 'nearest' })}
          />
        ))}
      </div>
    </div>
  )
}
