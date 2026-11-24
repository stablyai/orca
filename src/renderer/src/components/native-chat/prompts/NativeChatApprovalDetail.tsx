import { useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslate } from '@/i18n/use-translate'
import { approvalDetailPreview } from '../../../../../shared/agent-session/requests/prompts/agent-session-approval-detail-preview'

/** The full card's detail: a preview, and the whole text behind a Details row. */
export function NativeChatApprovalDetail({
  detail,
  scrollContainerRef
}: {
  detail: string
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const preview = approvalDetailPreview(detail)
  const hasMore = preview !== detail
  const textClassName = 'whitespace-pre-wrap break-words font-mono text-chat-code'
  return (
    <Collapsible
      open={expanded}
      onOpenChange={(open) => {
        const scroller = scrollContainerRef.current
        const trigger = triggerRef.current
        if (!open && scroller && trigger) {
          const rowBottom =
            trigger.getBoundingClientRect().bottom -
            scroller.getBoundingClientRect().top -
            scroller.clientTop +
            scroller.scrollTop
          scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight)
        }
        setExpanded(open)
      }}
    >
      <div className="space-y-2">
        {hasMore ? (
          <CollapsibleTrigger ref={triggerRef} variant="row">
            {t('components.native-chat.notices.details', 'Details')}
            <ChevronDown className="size-4 group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
        ) : null}
        {!expanded ? (
          <div
            data-native-chat-approval-detail="true"
            data-native-chat-code-content
            className={textClassName}
          >
            {preview}
          </div>
        ) : null}
        <CollapsibleContent>
          <div
            data-native-chat-approval-detail="true"
            data-native-chat-code-content
            className={textClassName}
          >
            {detail}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
