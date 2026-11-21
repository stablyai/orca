import { NativeChatSetupButton } from '../../host-access/NativeChatSetupButton'
import { NativeChatTranscriptSignInNotice } from '../../host-access/NativeChatSignInRow'
import { NativeChatUserBubble } from './NativeChatUserBubble'
import { NativeChatTextAttachments } from '../../media/text/NativeChatTextAttachments'
import { Goal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { AUTOMATION_RESULT_NOTE_COPY } from '../../../../../../shared/bots/bot-automation-result-note'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import { NativeChatRewindAction } from '../actions/NativeChatRewindAction'
import type { NativeChatRewindSurface } from '../actions/use-native-chat-rewind-host'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { NativeChatUserMessageFold } from './NativeChatUserMessageFold'
import { NativeChatCodeBlock } from '../../markdown/code/NativeChatCodeBlock'
import { NativeChatCopyButton } from '../actions/NativeChatCopyButton'
import { NativeChatMessageTimestamp } from './NativeChatMessageTimestamp'
import { useFoldedIntoBotRequest } from '../../bot-request-folded-mail'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { NativeChatConnectorAskerTag } from '../../NativeChatConnectorAskerTag'
import { NativeChatTypedByTag } from '../../NativeChatTypedByTag'
import {
  NativeChatSlackMirrorPostLine,
  NativeChatSlackMirrorTag,
  useNativeChatSlackMirrorPost
} from '../../slack-mirror/NativeChatSlackMirrorPost'
import { NativeChatConnectorNoAccessNote } from '../../NativeChatConnectorNoAccessNote'
import { NativeChatDetailsDisclosure } from '../diagnostics/NativeChatProviderDetails'
import { NativeChatImageAttachments } from '../../media/images/NativeChatImageAttachments'
import type { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import { NativeChatSentReferenceChips } from '../../selection-quotes/NativeChatAuxiliaryReferenceChips'
import { nativeChatSentPromptReferences } from '../../../../../../shared/native-chat/transcript/messages/native-chat-sent-prompt-references'

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
  const slackPost = useNativeChatSlackMirrorPost(message.id)
  // A bot request's answer shows on its card, not as a mailbox pointer.
  const folded = useFoldedIntoBotRequest(from)
  // A Slack message draws its markup; copy keeps `markdown`, its readable form.
  const drawn = message.drawnMarkdown
  if (folded) {
    return <div ref={rowRef} hidden />
  }
  const sentReferences = nativeChatSentPromptReferences(message)
  return (
    <div
      ref={rowRef}
      // Read by the context menu: only rows showing the hover copy or rewind offer them there.
      data-native-chat-message-id={markdown ? message.id : undefined}
      data-native-chat-selection-row={message.id}
      data-native-chat-rewind-item={rewind && !sending ? message.id : undefined}
      data-native-chat-slack-posted={slackPost?.state === 'posted' ? message.id : undefined}
      className={cn('group relative flex flex-col gap-0.5', from ? 'items-start' : 'items-end')}
    >
      {!from && message.asker ? <NativeChatConnectorAskerTag asker={message.asker} /> : null}
      {!from && !message.asker && (message.typedByOther || slackPost?.state === 'posted') ? (
        <div className="flex min-w-0 max-w-full justify-end gap-1.5">
          {message.typedByOther ? <NativeChatTypedByTag typist={message.typedByOther} /> : null}
          {slackPost?.state === 'posted' ? (
            <NativeChatSlackMirrorTag nameless={message.typedByOther !== undefined} />
          ) : null}
        </div>
      ) : null}
      {message.asker?.noAccess ? (
        <NativeChatConnectorNoAccessNote messageId={message.id} asker={message.asker} />
      ) : null}
      {from ? (
        <NativeChatAgentMessageCard
          message={message}
          from={from}
          textAttachmentContent={structuredAttachments ? markdown : undefined}
          runtimeContext={runtimeContext}
          onRefolded={onRefolded}
        />
      ) : (
        <NativeChatUserBubble>
          <NativeChatSentReferenceChips references={sentReferences} />
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
                  content={drawn ?? markdown}
                  structured={structuredAttachments}
                  runtimeContext={runtimeContext}
                  renderText={(text) => (
                    <NativeChatMarkdown
                      rowKey={message.id}
                      content={text}
                      variant="document"
                      slackMentions={drawn !== undefined}
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
        </NativeChatUserBubble>
      )}
      {message.sentAs === 'goal' ? (
        <div className="flex items-center gap-1 text-xs text-chat-foreground-faint">
          <Goal className="size-3" aria-hidden />
          <span>{t('components.native-chat.goal.sentAsGoal', 'Sent as goal')}</span>
        </div>
      ) : null}
      {message.automationResultsCarried ? (
        <p className="text-2xs text-chat-foreground-faint">
          {message.automationResultsCarried === 1
            ? t(
                'components.native-chat.automationResult.sentWithOne',
                AUTOMATION_RESULT_NOTE_COPY.sentWithOne
              )
            : t(
                'components.native-chat.automationResult.sentWithMany',
                AUTOMATION_RESULT_NOTE_COPY.sentWithMany,
                { count: message.automationResultsCarried }
              )}
        </p>
      ) : null}
      {!from ? (
        <UserMessageMeta
          markdown={markdown}
          timestamp={message.timestamp}
          sending={sending}
          {...(rewind ? { rewind: { itemId: message.id, surface: rewind } } : {})}
        />
      ) : null}
      {from ? null : <NativeChatSlackMirrorPostLine itemId={message.id} post={slackPost} />}
      {deliveryNotice?.text !== undefined && deliveryNotice.signIn ? (
        <NativeChatTranscriptSignInNotice
          agentName={deliveryNotice.signIn.agentName}
          account={deliveryNotice.signIn.account}
          rowId={message.id}
          sent
          className="max-w-[85%]"
          fallback={() => <NativeChatDeliveryLine notice={deliveryNotice} rowId={message.id} />}
        />
      ) : deliveryNotice?.text !== undefined ? (
        <NativeChatDeliveryLine notice={deliveryNotice} rowId={message.id} />
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

/** A refused send's words, under its message. */
function NativeChatDeliveryLine({
  notice,
  rowId
}: {
  notice: Extract<NativeChatDeliveryNotice, { text: string }>
  rowId: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex max-w-[85%] flex-wrap items-center gap-2 text-2xs text-destructive/80">
      <span className="min-w-0 break-words">{notice.text}</span>
      <NativeChatSetupButton failureKind={notice.failureKind} rowId={rowId} />
      {notice.onSend ? (
        <Button type="button" variant="ghost" size="xs" onClick={notice.onSend}>
          {t('components.native-chat.queuedMessages.send', 'Send')}
        </Button>
      ) : null}
      {notice.onEdit ? (
        <Button type="button" variant="ghost" size="xs" onClick={notice.onEdit}>
          {t('components.native-chat.editDeliveryNotice', 'Edit')}
        </Button>
      ) : null}
      {notice.onDismiss ? (
        <Button type="button" variant="ghost" size="xs" onClick={notice.onDismiss}>
          {t('components.native-chat.dismissDeliveryNotice', 'Dismiss')}
        </Button>
      ) : null}
    </div>
  )
}
