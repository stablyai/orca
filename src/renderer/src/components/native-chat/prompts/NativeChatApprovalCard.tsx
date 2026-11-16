import { SecuritySurface } from '@/components/ui/security-surface'
import { useRef, useState } from 'react'
import { ChevronDown, Loader2, ShieldQuestion, X } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { approvalDetailPreview } from '../../../../../shared/agent-session/agent-session-approval-detail-preview'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'
import { approvalBlockedPathToShow } from '../../../../../shared/agent-session/agent-session-approval-blocked-path'
import {
  isNewerApprovalSubject,
  isPlanApprovalSubject,
  isUrlApprovalSubject,
  readApprovalUrl,
  URL_APPROVAL_DECLINE_OPTION_ID,
  URL_APPROVAL_OPEN_OPTION_ID
} from '../../../../../shared/agent-session/agent-session-approval-subject'
import { NativeChatCodeBlock } from '../markdown/code/NativeChatCodeBlock'
import type { ChatApproval } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { NativeChatPromptCollapseToggle } from './NativeChatPromptCollapse'
import { useNativeChatPromptCardFocus } from './use-native-chat-prompt-card-focus'
import { NativeChatUrlTarget, openUrlRequestPage } from './NativeChatUrlRequest'

export type NativeChatApprovalCardProps = {
  approval: ChatApproval
  /** Deliver the option's transport-specific response token. */
  onChoose: (option: string) => void
  /** Cancel the active provider turn while this card owns the composer region. */
  onCancel?: () => void
  /** Without `onCancel`: fold the card to a strip and give the input back, writing nothing. */
  onCollapse?: () => void
  /** A choice is being delivered: the options wait for its answer. */
  isSubmitting?: boolean
  /** The option being sent, while `isSubmitting`: its button shows that it is working. */
  submittingOption?: string
  shouldFocus?: boolean
  /** Shown when the card has no options: only the terminal can answer it. */
  onOpenTerminal?: () => void
  /** A worker's prompt shown in its coordinator's chat: names the worker under the title. */
  worker?: { name: string; onOpen: () => void }
  /** Live time left before the agent decides on its own, shown only when its screen shows it. */
  countdown?: string
  /** `stacked`: one of several cards above the composer, not the chat's own slot (no slot height, no focus). */
  placement?: 'composer' | 'stacked'
}

/** PTY options are literal replies; structured options are journal ids. The first option is primary unless the options are neutral. */
export function NativeChatApprovalCard({
  approval,
  onChoose,
  onCancel,
  onCollapse,
  isSubmitting = false,
  submittingOption,
  shouldFocus = false,
  onOpenTerminal,
  worker,
  countdown,
  placement = 'composer'
}: NativeChatApprovalCardProps): React.JSX.Element {
  const t = useTranslate()
  const cardRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const neededPath = approvalBlockedPathToShow(approval)
  // A newer Orca's subject: its detail is shown, and only the card's cancel answers.
  const newerSubject = isNewerApprovalSubject(approval.subject)
  // A page to open: its option opens it, and the back-out stays quiet.
  const url = isUrlApprovalSubject(approval.subject) ? approval.subject.url : null
  const title =
    url === null
      ? approval.title
      : t('components.native-chat.urlRequest.title', 'Sign-in requested')
  const optionLabel = (option: ChatApproval['options'][number]): string =>
    url === null
      ? option.label
      : option.send === URL_APPROVAL_OPEN_OPTION_ID
        ? t('components.native-chat.urlRequest.open', 'Open sign-in page')
        : option.send === URL_APPROVAL_DECLINE_OPTION_ID
          ? t('components.native-chat.urlRequest.decline', 'Decline')
          : option.label
  const stacked = placement === 'stacked'
  const hasContext = Boolean(
    countdown ||
    approval.description ||
    approval.decisionReason ||
    neededPath ||
    approval.subject ||
    approval.detail
  )
  useNativeChatPromptCardFocus(cardRef, shouldFocus && !stacked)
  const escape = onCancel ?? (isSubmitting ? undefined : onCollapse)

  return (
    <SecuritySurface>
      <div className={stacked ? 'bg-chat-pane' : 'min-h-0 shrink overflow-hidden bg-chat-pane'}>
        <div
          className={cn(
            'mx-auto flex w-full max-w-(--chat-content-max-width) px-3 pt-2 pb-1 sm:px-4',
            !stacked && 'h-full min-h-0 max-h-full'
          )}
        >
          <div
            ref={cardRef}
            data-native-chat-prompt-card-focus={shouldFocus || undefined}
            data-native-chat-approval-card="true"
            role="group"
            aria-label={title}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing && escape) {
                event.preventDefault()
                event.stopPropagation()
                escape()
              }
            }}
            className="flex min-h-0 w-full flex-1 flex-col gap-2 overflow-hidden rounded-lg border border-input bg-card px-4 py-3 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex shrink-0 items-start gap-2">
              <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words text-sm font-semibold text-foreground">
                  {title}
                </p>
                {worker ? (
                  <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">
                      {t('components.native-chat.approval.worker', 'Worker · {{name}}', {
                        name: worker.name
                      })}
                    </span>
                    <span aria-hidden>·</span>
                    <button
                      type="button"
                      onClick={worker.onOpen}
                      className="shrink-0 rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t('components.native-chat.approval.openWorker', 'Open worker')}
                    </button>
                  </p>
                ) : null}
              </div>
              {onCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  aria-label={t('components.native-chat.approval.cancel', 'Cancel')}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-4" />
                </button>
              ) : onCollapse ? (
                <NativeChatPromptCollapseToggle
                  expanded
                  disabled={isSubmitting}
                  onToggle={onCollapse}
                />
              ) : null}
            </div>
            {hasContext ? (
              <div
                ref={contentRef}
                data-native-chat-approval-content="true"
                tabIndex={0}
                className="min-h-0 max-h-72 shrink space-y-2 overflow-auto text-sm text-muted-foreground scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {countdown ? <p className="tabular-nums">{countdown}</p> : null}
                {approval.description ? (
                  <p className="whitespace-pre-wrap break-words">{approval.description}</p>
                ) : null}
                {approval.decisionReason ? (
                  <p className="whitespace-pre-wrap break-words">
                    <span className="font-medium text-foreground">
                      {t('components.native-chat.approval.reason', 'Reason')}:{' '}
                    </span>
                    {approval.decisionReason}
                  </p>
                ) : null}
                {neededPath ? (
                  <p className="break-words">
                    <span className="font-medium text-foreground">
                      {t('components.native-chat.approval.needsAccess', 'Needs access to')}:{' '}
                    </span>
                    <span className="font-mono">{neededPath}</span>
                  </p>
                ) : null}
                {isPlanApprovalSubject(approval.subject) ? (
                  <div data-native-chat-approval-plan="true">
                    <NativeChatMarkdown
                      content={approval.subject.text}
                      variant="document"
                      className="text-sm text-chat-foreground"
                      renderCodeBlock={NativeChatCodeBlock}
                      linkifyFilePaths
                    />
                    {approval.subject.filePath ? (
                      <p className="mt-2 break-all">
                        <span className="font-medium text-foreground">
                          {t('components.native-chat.approval.plan.file', 'Plan file')}:{' '}
                        </span>
                        <span className="font-mono">{approval.subject.filePath}</span>
                      </p>
                    ) : null}
                  </div>
                ) : url !== null ? (
                  <NativeChatUrlTarget url={url} />
                ) : approval.detail ? (
                  <NativeChatApprovalDetail
                    detail={approval.detail}
                    scrollContainerRef={contentRef}
                  />
                ) : null}
                {newerSubject ? (
                  <p data-native-chat-approval-needs-newer-orca="true" className="break-words">
                    {t(
                      'components.native-chat.approval.needsNewerOrca',
                      'This request needs a newer version of Orca.'
                    )}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div data-native-chat-approval-actions="true" className="flex shrink-0 flex-wrap gap-2">
              {approval.options.map((opt, i) => {
                const opensUrl = url !== null && opt.send === URL_APPROVAL_OPEN_OPTION_ID
                return (
                  <button
                    key={`${opt.label}-${i}`}
                    type="button"
                    disabled={
                      newerSubject || isSubmitting || (opensUrl && readApprovalUrl(url) === null)
                    }
                    onClick={() => {
                      if (opensUrl) {
                        openUrlRequestPage(url)
                      }
                      onChoose(opt.send)
                    }}
                    className={cn(
                      'rounded-md px-4 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                      i === 0 && !approval.neutralOptions
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : url !== null
                          ? 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                          : 'border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground'
                    )}
                  >
                    {isSubmitting && opt.send === submittingOption ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        {optionLabel(opt)}
                      </span>
                    ) : (
                      optionLabel(opt)
                    )}
                  </button>
                )
              })}
              {approval.options.length === 0 && onOpenTerminal ? (
                <button
                  type="button"
                  onClick={onOpenTerminal}
                  className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('components.native-chat.question.openTerminal', 'Answer in terminal')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </SecuritySurface>
  )
}

function NativeChatApprovalDetail({
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
