import { useEffect, useRef, type ReactNode } from 'react'
import { ShieldQuestion, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { ChatApproval } from './native-chat-interactive-prompt'

export type NativeChatApprovalCardProps = {
  approval: ChatApproval
  /** Deliver the option's transport-specific response token. */
  onChoose: (option: string) => void
  /** Cancel the active provider turn while this card owns the composer region. */
  onCancel?: () => void
  body?: ReactNode
  shouldFocus?: boolean
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
  body,
  shouldFocus = false
}: NativeChatApprovalCardProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (shouldFocus) {
      cardRef.current?.focus()
    }
  }, [shouldFocus])

  return (
    <div className="shrink-0 bg-background">
      <div className="mx-auto w-full max-w-4xl px-3 pt-2 pb-1 sm:px-4">
        <div
          ref={cardRef}
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
          className="flex w-full flex-col gap-2 rounded-lg border border-input bg-card px-4 py-3 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start gap-2">
            <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{approval.title}</p>
              {approval.description ? (
                <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {approval.description}
                </p>
              ) : null}
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
          {approval.decisionReason ? (
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">
                {translate('components.native-chat.approval.reason', 'Reason')}:{' '}
              </span>
              {approval.decisionReason}
            </p>
          ) : null}
          {approval.blockedPath ? (
            <p className="break-words text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">
                {translate('components.native-chat.approval.blockedPath', 'Blocked path')}:{' '}
              </span>
              <span className="font-mono">{approval.blockedPath}</span>
            </p>
          ) : null}
          {approval.matchedAskRule ? (
            <p className="break-words text-xs text-muted-foreground">
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
          {body ??
            (approval.detail ? (
              <div
                data-native-chat-approval-detail="true"
                tabIndex={0}
                className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              >
                {approval.detail}
              </div>
            ) : null)}
          <div className="flex flex-wrap gap-2">
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
