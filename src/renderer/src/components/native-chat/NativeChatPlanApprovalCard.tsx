import { ChevronRight } from 'lucide-react'
import type { AgentJournalApprovalSubject } from '../../../../shared/agent-session-journal-types'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { NativeChatApprovalCard, type NativeChatApprovalCardProps } from './NativeChatApprovalCard'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'

export type NativeChatPlanApprovalCardProps = Omit<NativeChatApprovalCardProps, 'body'> & {
  plan: AgentJournalApprovalSubject
  disclosureKey: string
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}

export function NativeChatPlanApprovalCard({
  plan,
  disclosureKey,
  onLinkClick,
  allowFileUriLinks = false,
  ...approvalProps
}: NativeChatPlanApprovalCardProps): React.JSX.Element {
  const { open: expanded, setOpen: setExpanded } = useNativeChatDisclosure(disclosureKey, true)
  return (
    <NativeChatApprovalCard
      {...approvalProps}
      body={
        <div className="min-w-0">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="group flex items-center gap-1.5 rounded-md py-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', expanded && 'rotate-90')}
            />
            {expanded
              ? translate('components.native-chat.approval.plan.collapse', 'Collapse plan')
              : translate('components.native-chat.approval.plan.expand', 'Expand plan')}
          </button>
          {expanded ? (
            <div
              data-native-chat-plan-body="true"
              tabIndex={0}
              className="max-h-72 overflow-auto border-t border-border pt-2 scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            >
              <CommentMarkdown
                content={plan.text}
                variant="document"
                className="text-sm"
                renderCodeBlock={NativeChatCodeBlock}
                onLinkClick={onLinkClick}
                allowFileUriLinks={allowFileUriLinks}
                linkifyFilePaths={onLinkClick !== undefined}
              />
              {plan.filePath ? (
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">
                    {translate('components.native-chat.approval.plan.file', 'Plan file')}:{' '}
                  </span>
                  <span className="font-mono">{plan.filePath}</span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    />
  )
}
