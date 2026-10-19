import { Check, ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import type { NativeChatTextBlock } from '../../../../shared/native-chat-types'
import { ProviderFrameRow } from './NativeChatTranscriptChrome'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'

/** Only a provider's successful review, never an approval request or an assistant's prose. */
export function isNativeChatAutoApprovalNotice(block: NativeChatTextBlock): boolean {
  return (
    block.tone === 'warning' &&
    block.presentation === undefined &&
    block.failure === undefined &&
    block.orcaStop === undefined &&
    block.providerFrame?.provider === 'codex' &&
    (block.providerFrame.kind === 'notification:warning' ||
      block.providerFrame.kind === 'notification:guardianWarning') &&
    /^Automatic approval review approved \([^\n)]+\):\s+\S/.test(block.text)
  )
}

export function NativeChatAutoApprovalNotice({
  block,
  messageId
}: {
  block: NativeChatTextBlock
  messageId?: string
}): React.JSX.Element {
  const disclosure = useNativeChatDisclosure(
    messageId === undefined ? undefined : `auto-approval:${messageId}`,
    false
  )
  return (
    <Collapsible open={disclosure.open} onOpenChange={disclosure.setOpen}>
      <CollapsibleTrigger variant="transcript" className="group/auto-approval">
        <Check aria-hidden="true" className="size-4 shrink-0" />
        <span>
          {translate(
            'components.native-chat.notices.autoApprovalGranted',
            'Automatic approval granted'
          )}
        </span>
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform motion-reduce:transition-none group-data-[state=open]/auto-approval:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/20 p-3 text-sm text-chat-foreground">
          <p className="whitespace-pre-wrap break-words">{block.text}</p>
          <ProviderFrameRow
            block={block}
            summary={translate('components.native-chat.notices.details', 'Details')}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
