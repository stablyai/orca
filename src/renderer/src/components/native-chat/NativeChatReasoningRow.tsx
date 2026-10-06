import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  nativeChatReasoningDisclosureKey,
  nativeChatReasoningHeadline,
  type NativeChatReasoningHeadline
} from '../../../../shared/native-chat-reasoning-row'
import {
  NativeChatReasoningBody,
  NativeChatReasoningChevron
} from './NativeChatReasoningDisclosure'
import { NativeChatToolRunIcon } from './NativeChatToolIcon'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'

function translatedHeadline(headline: NativeChatReasoningHeadline): string {
  if (headline.kind === 'thoughtFor') {
    return translate('components.native-chat.thoughtForDuration', 'Thought for {{duration}}', {
      duration: headline.duration
    })
  }
  return headline.kind === 'thought'
    ? translate('components.native-chat.thought', 'Thought')
    : translate('components.native-chat.reasoning', 'Reasoning')
}

export function NativeChatReasoningRow({
  message,
  markdown,
  turnIsWorking = false,
  onLinkClick,
  allowFileUriLinks
}: {
  message: Pick<NativeChatMessage, 'id' | 'role' | 'state' | 'completedAt' | 'timestamp'>
  markdown: string
  /** The row's own turn (or subagent) is still running; an open row there has not ended. */
  turnIsWorking?: boolean
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element | null {
  // Keyed like the live line, so a block opened while it streamed lands open, and windowing keeps it.
  const disclosure = useNativeChatDisclosure(nativeChatReasoningDisclosureKey(message.id), false)
  if (!markdown.trim()) {
    return null
  }
  const label = translate('components.native-chat.reasoning', 'Reasoning')
  const headline = translatedHeadline(nativeChatReasoningHeadline(message, { live: turnIsWorking }))

  return (
    <div className="min-w-0 text-sm text-muted-foreground">
      <Collapsible open={disclosure.open} onOpenChange={disclosure.setOpen}>
        <CollapsibleTrigger asChild>
          {/* Laid out like a tool run's header, so its glyph sits in the same column. */}
          <button
            type="button"
            className="group/reasoning flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          >
            {headline === label ? null : <span className="sr-only">{label}: </span>}
            <NativeChatToolRunIcon iconName="brain" className="text-chat-foreground-faint" />
            <span className="min-w-0 truncate text-sm native-chat-message-text leading-relaxed text-chat-foreground-faint transition-colors group-hover/reasoning:text-chat-foreground">
              {headline}
            </span>
            <NativeChatReasoningChevron />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <NativeChatReasoningBody
            markdown={markdown}
            onLinkClick={onLinkClick}
            allowFileUriLinks={allowFileUriLinks}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
