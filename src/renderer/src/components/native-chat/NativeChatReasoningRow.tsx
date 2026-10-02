import { ChevronRight } from 'lucide-react'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  nativeChatReasoningHeadline,
  type NativeChatReasoningHeadline
} from '../../../../shared/native-chat-reasoning-row'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'

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
  onLinkClick,
  allowFileUriLinks
}: {
  message: Pick<NativeChatMessage, 'state' | 'completedAt' | 'timestamp'>
  markdown: string
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}): React.JSX.Element | null {
  // A row still underway never reaches here: the transcript skips it while the host reports it open.
  if (!markdown.trim()) {
    return null
  }
  const label = translate('components.native-chat.reasoning', 'Reasoning')
  const headline = translatedHeadline(nativeChatReasoningHeadline(message))

  return (
    <div className="min-w-0 text-sm text-muted-foreground">
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="xs" className="group w-full min-w-0 justify-start">
            {headline === label ? null : <span className="sr-only">{label}: </span>}
            <span className="min-w-0 truncate">{headline}</span>
            <ChevronRight
              aria-hidden
              className="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 pl-4 italic">
            <CommentMarkdown
              content={markdown}
              variant="document"
              className="text-sm"
              renderCodeBlock={NativeChatCodeBlock}
              onLinkClick={onLinkClick}
              allowFileUriLinks={allowFileUriLinks}
              linkifyFilePaths={onLinkClick !== undefined}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
