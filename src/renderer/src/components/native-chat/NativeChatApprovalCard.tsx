import { useEffect, useRef } from 'react'
import { ShieldQuestion, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import CommentMarkdown, {
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import type { ChatApproval } from './native-chat-interactive-prompt'

export type NativeChatApprovalCardProps = {
  approval: ChatApproval
  /** Deliver the option's transport-specific response token. */
  onChoose: (option: string) => void
  /** Cancel the active provider turn while this card owns the composer region. */
  onCancel?: () => void
  shouldFocus?: boolean
  /** A plan body renders as markdown; these make its file paths clickable. */
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
}

/**
 * Native renderer for an agent tool-approval (PermissionRequest) as an
 * Allow/Deny card. PTY callers supply literal replies while structured callers
 * supply journal option IDs. The first option gets the primary styling.
 */
export function NativeChatApprovalCard({
  approval,
  onChoose,
  onCancel,
  shouldFocus = false,
  onLinkClick,
  allowFileUriLinks = false
}: NativeChatApprovalCardProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const hasContext = Boolean(
    approval.description ||
    approval.decisionReason ||
    approval.blockedPath ||
    approval.matchedAskRule ||
    approval.subject ||
    approval.detail
  )
  useEffect(() => {
    if (shouldFocus) {
      cardRef.current?.focus()
    }
  }, [shouldFocus])

  return (
    <div className="min-h-0 shrink overflow-hidden bg-background">
      <div className="mx-auto flex h-full min-h-0 max-h-full w-full max-w-4xl px-3 pt-2 pb-1 sm:px-4">
        <div
          ref={cardRef}
          data-native-chat-approval-card="true"
          role="group"
          aria-label={approval.title}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing && onCancel) {
              event.preventDefault()
              event.stopPropagation()
              onCancel()
            }
          }}
          className="flex min-h-0 w-full flex-1 flex-col gap-2 overflow-hidden rounded-lg border border-input bg-card px-4 py-3 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex shrink-0 items-start gap-2">
            <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 break-words text-sm font-semibold text-foreground">
                {approval.title}
              </p>
            </div>
            {onCancel ? (
              <button
                type="button"
                onClick={onCancel}
                aria-label={translate('components.native-chat.approval.cancel', 'Cancel')}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
          {hasContext ? (
            <div
              data-native-chat-approval-content="true"
              tabIndex={0}
              className="min-h-0 max-h-72 shrink space-y-2 overflow-auto text-xs text-muted-foreground scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            >
              {approval.description ? (
                <p className="whitespace-pre-wrap break-words">{approval.description}</p>
              ) : null}
              {approval.decisionReason ? (
                <p className="whitespace-pre-wrap break-words">
                  <span className="font-medium text-foreground/80">
                    {translate('components.native-chat.approval.reason', 'Reason')}:{' '}
                  </span>
                  {approval.decisionReason}
                </p>
              ) : null}
              {approval.blockedPath ? (
                <p className="break-words">
                  <span className="font-medium text-foreground/80">
                    {translate('components.native-chat.approval.blockedPath', 'Blocked path')}:{' '}
                  </span>
                  <span className="font-mono">{approval.blockedPath}</span>
                </p>
              ) : null}
              {approval.matchedAskRule ? (
                <p className="break-words">
                  <span className="font-medium text-foreground/80">
                    {translate('components.native-chat.approval.askRule', 'Ask rule')}:{' '}
                  </span>
                  {approval.matchedAskRule.ruleContent ?? approval.matchedAskRule.toolName}
                  <span className="text-muted-foreground/80">
                    {' · '}
                    {approval.matchedAskRule.source}
                  </span>
                </p>
              ) : null}
              {approval.subject?.kind === 'plan' ? (
                <div data-native-chat-approval-plan="true">
                  <CommentMarkdown
                    content={approval.subject.text}
                    variant="document"
                    className="text-sm"
                    renderCodeBlock={NativeChatCodeBlock}
                    {...(onLinkClick ? { onLinkClick } : {})}
                    allowFileUriLinks={allowFileUriLinks}
                    linkifyFilePaths={onLinkClick !== undefined}
                  />
                  {approval.subject.filePath ? (
                    <p className="mt-2 break-all">
                      <span className="font-medium text-foreground/80">
                        {translate('components.native-chat.approval.plan.file', 'Plan file')}:{' '}
                      </span>
                      <span className="font-mono">{approval.subject.filePath}</span>
                    </p>
                  ) : null}
                </div>
              ) : approval.detail ? (
                <div
                  data-native-chat-approval-detail="true"
                  className="whitespace-pre-wrap break-words font-mono"
                >
                  {approval.detail}
                </div>
              ) : null}
            </div>
          ) : null}
          <div data-native-chat-approval-actions="true" className="flex shrink-0 flex-wrap gap-2">
            {approval.options.map((opt, i) => (
              <button
                key={`${opt.label}-${i}`}
                type="button"
                onClick={() => onChoose(opt.send)}
                className={cn(
                  'rounded-md px-4 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  i === 0
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'border border-border bg-background text-foreground hover:bg-accent'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
