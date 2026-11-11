import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  nativeChatReasoningDisclosureKey,
  nativeChatReasoningHeadline,
  type NativeChatReasoningHeadline
} from '../../../../../../shared/native-chat/transcript/native-chat-reasoning-row'
import {
  NativeChatReasoningBody,
  NativeChatReasoningChevron
} from './NativeChatReasoningDisclosure'
import { NativeChatToolRunIcon } from '../../tools/lines/NativeChatToolIcon'
import { useNativeChatDisclosure } from '../disclosure/native-chat-disclosure-store'

function translatedHeadline(
  headline: NativeChatReasoningHeadline,
  t: Translate = translate
): string {
  if (headline.kind === 'thoughtFor') {
    return t('components.native-chat.thoughtForDuration', 'Thought for {{duration}}', {
      duration: headline.duration
    })
  }
  return headline.kind === 'thought'
    ? t('components.native-chat.thought', 'Thought')
    : t('components.native-chat.reasoning', 'Reasoning')
}

export function NativeChatReasoningRow({
  message,
  markdown,
  turnIsWorking = false
}: {
  message: Pick<NativeChatMessage, 'id' | 'role' | 'state' | 'completedAt' | 'timestamp'>
  markdown: string
  /** The row's own turn (or subagent) is still running; an open row there has not ended. */
  turnIsWorking?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  // Keyed like the live line, so a block opened while it streamed lands open, and windowing keeps it.
  const disclosureKey = nativeChatReasoningDisclosureKey(message.id)
  const disclosure = useNativeChatDisclosure(disclosureKey, false)
  if (!markdown.trim()) {
    return null
  }
  const label = t('components.native-chat.reasoning', 'Reasoning')
  const headline = translatedHeadline(
    nativeChatReasoningHeadline(message, { live: turnIsWorking }),
    t
  )

  return (
    <div className="min-w-0 text-sm text-chat-foreground-faint">
      <Collapsible open={disclosure.open} onOpenChange={disclosure.setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group/reasoning flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {headline === label ? null : <span className="sr-only">{label}: </span>}
            <NativeChatToolRunIcon iconName="brain" className="text-chat-foreground-faint" />
            <span className="min-w-0 truncate text-sm leading-relaxed text-chat-foreground-faint transition-colors group-hover/reasoning:text-chat-foreground">
              {headline}
            </span>
            <NativeChatReasoningChevron />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent animation="height" data-native-chat-member-detail>
          <NativeChatReasoningBody rowKey={disclosureKey} markdown={markdown} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
