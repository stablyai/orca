import { useEffect, useRef, useState } from 'react'
import { MessageCircle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { NativeChatPromptPill } from './NativeChatPromptPill'
import { translate } from '@/i18n/i18n'
import type { ConversationReferenceMessage } from '../../../../shared/conversation-reference'

export function NativeChatConversationReference({
  uri,
  title,
  selected = false
}: {
  uri: string
  title: string
  selected?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ConversationReferenceMessage[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const generation = useRef(0)
  const load = async (next?: string): Promise<void> => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const page = await window.api.aiVault.readConversationReference({
        reference: uri,
        ...(next ? { cursor: next } : {})
      })
      if (generation.current !== request) {
        return
      }
      setMessages((current) => (next ? [...current, ...page.messages] : page.messages))
      setCursor(page.nextCursor)
      setWarnings(page.warnings)
    } catch (failure) {
      if (generation.current === request) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    } finally {
      if (generation.current === request) {
        setLoading(false)
      }
    }
  }
  useEffect(
    () => () => {
      generation.current++
    },
    []
  )
  return (
    <>
      <button
        type="button"
        className="inline max-w-full align-baseline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
        data-native-chat-conversation-reference={uri}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen(true)
          void load()
        }}
      >
        <NativeChatPromptPill
          icon={MessageCircle}
          label={title}
          selected={selected}
          title={title}
        />
      </button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value)
          if (!value) {
            generation.current++
          }
        }}
      >
        <DialogContent className="max-h-[80vh] sm:max-w-2xl" scrollable>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {translate(
                'components.native-chat.conversationReference.source',
                'Referenced conversation'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            {messages.map((message) => (
              <div
                key={`${message.messageIndex}:${message.textOffset}`}
                className="space-y-1 border-b border-border pb-3"
              >
                <div className="text-xs font-medium text-muted-foreground">
                  {message.role === 'user'
                    ? translate('components.native-chat.conversationReference.user', 'User')
                    : message.role === 'assistant'
                      ? translate(
                          'components.native-chat.conversationReference.assistant',
                          'Assistant'
                        )
                      : translate('components.native-chat.conversationReference.tool', 'Tool')}
                </div>
                <div className="whitespace-pre-wrap break-words select-text">{message.text}</div>
              </div>
            ))}
            {warnings.map((warning) => (
              <p key={warning} className="text-xs text-muted-foreground">
                {warning}
              </p>
            ))}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
                {translate(
                  'components.native-chat.conversationReference.loading',
                  'Reading conversation'
                )}
              </div>
            ) : null}
            {!loading && !error && messages.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'components.native-chat.conversationReference.empty',
                  'This conversation has no readable text.'
                )}
              </p>
            ) : null}
            {!loading && (cursor || error) ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load(error ? undefined : (cursor ?? undefined))}
              >
                {error
                  ? translate('components.native-chat.conversationReference.retry', 'Retry')
                  : translate('components.native-chat.conversationReference.more', 'Load more')}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
