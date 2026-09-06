import { useContext } from 'react'
import { Unplug, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { CanvasNode } from './agent-canvas-document'
import { CanvasContextStatus } from './use-canvas-agent-context'
import { useCanvasMessageHistory } from './use-canvas-message-history'

export function AgentCanvasConversation({
  source,
  target,
  scope,
  paused,
  readOnly,
  onClose,
  onRemove
}: {
  source: CanvasNode
  target: CanvasNode
  scope?: string
  paused?: boolean
  readOnly: boolean
  onClose: () => void
  onRemove: () => void
}) {
  const history = useCanvasMessageHistory(scope)
  const context = useContext(CanvasContextStatus)
  const messages = history.messages.filter(
    (message) =>
      (message.source === source.id && message.target === target.id) ||
      (message.source === target.id && message.target === source.id)
  )
  const states = [context.nodes[source.id]?.state, context.nodes[target.id]?.state]
  const ready = states.every((state) => state === 'returned' || state === 'ready')
  const labels = {
    queued: translate('agentCanvas.messageQueued', 'Queued'),
    sending: translate('agentCanvas.messageSending', 'Submitting'),
    delivered: translate('agentCanvas.messageDelivered', 'Submitted to terminal'),
    received: translate('agentCanvas.messageReceived', 'Retrieved by agent'),
    cancelled: translate('agentCanvas.messageCancelled', 'Cancelled'),
    unverifiable: translate('agentCanvas.messageUnverifiable', 'Delivery unverifiable')
  }
  return (
    <aside
      className="flex max-h-[min(32rem,70vh)] flex-col gap-3 p-3"
      aria-label={translate('agentCanvas.conversation', 'Agent collaboration')}
    >
      <div className="flex items-center gap-2 text-[13px] font-medium">
        <span className="min-w-0 flex-1 break-words">
          {source.title} ↔ {target.title}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label={translate('agentCanvas.closeConnection', 'Close connection details')}
        >
          <X />
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {paused
          ? translate(
              'agentCanvas.collaborationPaused',
              'Collaboration paused · messages stay queued'
            )
          : (context.error ??
            (ready
              ? translate(
                  'agentCanvas.collaborationReady',
                  'Connected · agents can exchange messages'
                )
              : states.includes('unsupported')
                ? translate(
                    'agentCanvas.collaborationUnsupported',
                    'Messaging unavailable on this execution host'
                  )
                : translate(
                    'agentCanvas.collaborationWaiting',
                    'Waiting for both agent sessions · run a prompt to activate'
                  )))}
      </p>
      <p className="text-xs text-muted-foreground">
        {translate(
          'agentCanvas.collaborationHint',
          'Agents choose when to ask, share a result, or reply. Connecting does not send terminal history. New messages wait until the recipient is idle and its input is empty.'
        )}
      </p>
      <div
        className="scrollbar-sleek min-h-0 overflow-y-auto"
        aria-label={translate('agentCanvas.messageHistory', 'Message history')}
      >
        {history.error && (
          <p role="alert" className="mb-2 break-words text-xs text-destructive">
            {history.error}
          </p>
        )}
        {history.loading ? (
          <p className="text-xs text-muted-foreground">
            {translate('agentCanvas.messagesLoading', 'Loading messages…')}
          </p>
        ) : !messages.length && !history.error ? (
          <p className="py-3 text-xs text-muted-foreground">
            {translate(
              'agentCanvas.messagesEmpty',
              'No messages yet. Ask either agent to collaborate with its connected teammate.'
            )}
          </p>
        ) : null}
        <ol className="divide-y divide-border">
          {messages.map((message) => {
            const replied = messages.some((reply) => reply.replyTo === message.id)
            return (
              <li key={message.id} className="space-y-1 py-3 first:pt-0">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 break-words font-medium">
                    {message.sourceName} → {message.targetName}
                  </span>
                  <time
                    className="shrink-0 text-muted-foreground"
                    dateTime={new Date(message.createdAt).toISOString()}
                  >
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </time>
                </div>
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">
                  {message.body}
                </p>
                <p className="text-xs text-muted-foreground">
                  {replied
                    ? translate('agentCanvas.messageReplied', 'Replied')
                    : labels[message.state]}
                </p>
                {message.detail && (
                  <p className="break-words text-xs text-muted-foreground">{message.detail}</p>
                )}
              </li>
            )
          })}
        </ol>
      </div>
      <Button variant="ghost" size="sm" className="shrink-0" disabled={readOnly} onClick={onRemove}>
        <Unplug />
        {translate('agentCanvas.disconnect', 'Disconnect')}
      </Button>
    </aside>
  )
}
