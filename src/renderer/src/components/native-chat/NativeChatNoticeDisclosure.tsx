import { ChevronRight, RotateCcw } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_NOTICE_COPY,
  nativeChatNoticeDisclosureKey,
  type NativeChatNoticeDisclosureLook
} from '../../../../shared/native-chat-notice'
import type { NativeChatTextBlock } from '../../../../shared/native-chat-types'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { ProviderFrameRow } from './NativeChatTranscriptChrome'

function headline(look: NativeChatNoticeDisclosureLook): string {
  if (look.label === 'configuration') {
    return translate(
      'components.native-chat.notices.configuration',
      NATIVE_CHAT_NOTICE_COPY.configuration
    )
  }
  if (look.label === 'deprecation') {
    return translate(
      'components.native-chat.notices.deprecation',
      NATIVE_CHAT_NOTICE_COPY.deprecation
    )
  }
  if (!look.attempt) {
    return translate('components.native-chat.notices.retrying', NATIVE_CHAT_NOTICE_COPY.retrying)
  }
  return look.maxRetries
    ? translate(
        'components.native-chat.notices.retryAttemptOf',
        NATIVE_CHAT_NOTICE_COPY.retryAttemptOf,
        {
          attempt: look.attempt,
          maxRetries: look.maxRetries
        }
      )
    : translate(
        'components.native-chat.notices.retryAttempt',
        NATIVE_CHAT_NOTICE_COPY.retryAttempt,
        {
          attempt: look.attempt
        }
      )
}

export function NativeChatNoticeDisclosure({
  block,
  look,
  messageId
}: {
  block: NativeChatTextBlock
  look: NativeChatNoticeDisclosureLook
  messageId?: string
}): React.JSX.Element {
  const disclosure = useNativeChatDisclosure(
    messageId === undefined ? undefined : nativeChatNoticeDisclosureKey(messageId),
    false
  )
  const detail = block.failure?.detail
  return (
    <Collapsible open={disclosure.open} onOpenChange={disclosure.setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group/notice flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left text-sm text-chat-foreground-faint hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {look.label === 'retrying' ? (
            <RotateCcw aria-hidden className="size-3.5 shrink-0" />
          ) : null}
          <span className="min-w-0 flex-1">{headline(look)}</span>
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]/notice:rotate-90 motion-reduce:transition-none"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent data-native-chat-member-detail>
        <div className="space-y-2 border-l border-border py-2 pl-4 text-sm text-chat-foreground">
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{block.text}</p>
          {detail?.audience === 'person' && !block.text.includes(detail.text.trim()) ? (
            <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{detail.text}</p>
          ) : null}
          <ProviderFrameRow
            block={block}
            summary={translate('components.native-chat.notices.details', 'Details')}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
