import { NativeChatSetupButton } from '../../host-access/NativeChatSetupButton'
import { NativeChatTextAttachments } from '../../media/text/NativeChatTextAttachments'
import { Goal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import { NativeChatRewindAction } from '../actions/NativeChatRewindAction'
import type { NativeChatRewindSurface } from '../actions/use-native-chat-rewind-host'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatUserMessageFold } from './NativeChatUserMessageFold'
import { NativeChatCodeBlock } from '../../markdown/code/NativeChatCodeBlock'
import { NativeChatCopyButton } from '../actions/NativeChatCopyButton'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { NativeChatDetailsDisclosure } from '../diagnostics/NativeChatProviderDetails'
import { NativeChatImageAttachments } from '../../media/images/NativeChatImageAttachments'
import type { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/native-chat-row-content'

const USER_META_REVEAL =
  'transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100'

/** Sending replaces the timestamp without changing row height; image-only prompts offer no text copy. */
function UserMessageMeta({
  markdown,
  timestamp,
  sending,
  rewind
}: {
  markdown: string
  timestamp: number | null
  sending: boolean
  rewind?: { itemId: string; surface: NativeChatRewindSurface }
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!markdown && timestamp === null && !sending && !rewind) {
    return null
  }
  return (
    <div
      // Hover-only once sent, so find skips it; "Sending…" stays on screen and stays findable.
      data-native-chat-find-skip={sending ? undefined : true}
      className={cn('flex select-none items-center gap-1', !sending && USER_META_REVEAL)}
    >
      {markdown ? (
        <NativeChatCopyButton text={markdown} className={sending ? USER_META_REVEAL : undefined} />
      ) : null}
      {sending ? (
        <span className="text-xs whitespace-nowrap text-chat-foreground-faint">
          {t('components.native-chat.messageSending', 'Sending…')}
        </span>
      ) : (
        <NativeChatMessageTimestamp timestamp={timestamp} focusable />
      )}
      {rewind && !sending ? (
        <NativeChatRewindAction itemId={rewind.itemId} rewind={rewind.surface} />
      ) : null}
    </div>
  )
}

export function NativeChatUserMessageRow({
  message,
  markdown,
  prose,
  rowRef,
  onRefolded,
  runtimeContext,
  structuredAttachments = false,
  rewind,
  deliveryNotice
}: {
  message: NativeChatMessage
  markdown: string
  prose: ReturnType<typeof deriveNativeChatRowContent>['prose']
  rowRef: React.RefObject<HTMLDivElement | null>
  onRefolded: () => void
  structuredAttachments?: boolean
  runtimeContext?: RuntimeFileOperationArgs | null
  rewind?: NativeChatRewindSurface
  deliveryNotice?: NativeChatDeliveryNotice
}): React.JSX.Element {
  const t = useTranslate()
  // Agent-authored input belongs to the turn but uses a left-aligned sender row instead of the person’s bubble.
  const from = message.from
  const sending = deliveryNotice?.sending === true
  return (
    <div
      ref={rowRef}
      // Read by the context menu: only rows showing the hover copy or rewind offer them there.
      data-native-chat-message-id={markdown ? message.id : undefined}
      data-native-chat-rewind-item={rewind && !sending ? message.id : undefined}
      className={cn('group relative flex flex-col gap-0.5', from ? 'items-start' : 'items-end')}
    >
      {from ? (
        <NativeChatAgentMessageCard
          message={message}
          from={from}
          textAttachmentContent={structuredAttachments ? markdown : undefined}
          runtimeContext={runtimeContext}
          onRefolded={onRefolded}
        />
      ) : (
        <div className="max-w-[80%] rounded-xl border border-chat-user-border bg-chat-user-surface px-3.5 py-2.5 text-sm text-chat-foreground-strong">
          {markdown ? (
            <>
              <NativeChatImageAttachments
                blocks={prose}
                runtimeContext={runtimeContext}
                enablePreview={runtimeContext !== undefined}
              />
              <NativeChatUserMessageFold
                messageId={message.id}
                markdown={markdown}
                onRefolded={onRefolded}
                // List numbers hang into the bubble's padding; clipping at the text edge cut them off.
                className="-mx-3.5 px-3.5"
              >
                <NativeChatTextAttachments
                  content={markdown}
                  structured={structuredAttachments}
                  runtimeContext={runtimeContext}
                  renderText={(text) => (
                    <NativeChatMarkdown
                      rowKey={message.id}
                      content={text}
                      variant="document"
                      className="text-sm"
                      renderCodeBlock={NativeChatCodeBlock}
                    />
                  )}
                />
              </NativeChatUserMessageFold>
            </>
          ) : (
            <NativeChatImageAttachments
              blocks={prose}
              runtimeContext={runtimeContext}
              enablePreview={runtimeContext !== undefined}
            />
          )}
        </div>
      )}
      {message.sentAs === 'goal' ? (
        <div className="flex items-center gap-1 text-xs text-chat-foreground-faint">
          <Goal className="size-3" aria-hidden />
          <span>{t('components.native-chat.goal.sentAsGoal', 'Sent as goal')}</span>
        </div>
      ) : null}
      {!from ? (
        <UserMessageMeta
          markdown={markdown}
          timestamp={message.timestamp}
          sending={sending}
          {...(rewind ? { rewind: { itemId: message.id, surface: rewind } } : {})}
        />
      ) : null}
      {deliveryNotice?.text !== undefined ? (
        <div className="flex max-w-[85%] flex-wrap items-center gap-2 text-2xs text-destructive/80">
          <span className="min-w-0 break-words">{deliveryNotice.text}</span>
          <NativeChatSetupButton failureKind={deliveryNotice.failureKind} />
          {deliveryNotice.onSend ? (
            <Button type="button" variant="ghost" size="xs" onClick={deliveryNotice.onSend}>
              {t('components.native-chat.queuedMessages.send', 'Send')}
            </Button>
          ) : null}
          {deliveryNotice.onEdit ? (
            <Button type="button" variant="ghost" size="xs" onClick={deliveryNotice.onEdit}>
              {t('components.native-chat.editDeliveryNotice', 'Edit')}
            </Button>
          ) : null}
          {deliveryNotice.onDismiss ? (
            <Button type="button" variant="ghost" size="xs" onClick={deliveryNotice.onDismiss}>
              {t('components.native-chat.dismissDeliveryNotice', 'Dismiss')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {deliveryNotice?.detail ? (
        <div className="max-w-[85%]">
          <NativeChatDetailsDisclosure
            summary={t('components.native-chat.notices.details', 'Details')}
          >
            {deliveryNotice.detail}
          </NativeChatDetailsDisclosure>
        </div>
      ) : null}
    </div>
  )
}
