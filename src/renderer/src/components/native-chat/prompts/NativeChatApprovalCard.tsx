import { SecuritySurface } from '@/components/ui/security-surface'
import { useRef } from 'react'
import { ChevronDown, Loader2, ShieldQuestion, X } from 'lucide-react'
import { NativeChatApprovalDetail } from './NativeChatApprovalDetail'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatMarkdown } from '../markdown/NativeChatMarkdown'
import { approvalBlockedPathToShow } from '../../../../../shared/agent-session/requests/prompts/agent-session-approval-blocked-path'
import {
  isNewerApprovalSubject,
  isPlanApprovalSubject,
  isUrlApprovalSubject,
  readApprovalUrl,
  URL_APPROVAL_DECLINE_OPTION_ID,
  URL_APPROVAL_OPEN_OPTION_ID
} from '../../../../../shared/agent-session/requests/prompts/agent-session-approval-subject'
import { NativeChatCodeBlock } from '../markdown/code/NativeChatCodeBlock'
import type { ChatApproval } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { NativeChatPromptCollapseToggle } from './NativeChatPromptCollapse'
import { useNativeChatPromptCardFocus } from './use-native-chat-prompt-card-focus'
import { useNativeChatApprovalQuietDetail } from './use-native-chat-approval-quiet-detail'
import { useNativeChatDockRefit } from '../pane/dock/use-native-chat-dock-fit'
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
  /** Read off a terminal screen (folder trust, startup menus): keeps the full card. */
  parsedFromTerminal?: boolean
  /** Shown as the title, with mention pills; `approval.title` stays its name for assistive tech. */
  titleContent?: React.ReactNode
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
  placement = 'composer',
  parsedFromTerminal = false,
  titleContent
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
  // A tool call's prompt reads as a quiet transcript row; plan reviews, sign-ins and prompts read
  // off a terminal screen keep the full card.
  const quiet = !parsedFromTerminal && url === null && !isPlanApprovalSubject(approval.subject)
  const {
    text: quietDetailText,
    otherArguments: quietOtherArguments,
    textRef: quietDetailRef,
    otherArgumentsRef: quietOtherArgumentsRef,
    open: quietDetailOpen,
    setOpen: setQuietDetailOpen,
    showsToggle: showsQuietDetailToggle
  } = useNativeChatApprovalQuietDetail(
    quiet ? (approval.detail ?? null) : null,
    approval.toolName,
    approval.description
  )
  const hasContext = Boolean(
    countdown ||
    approval.description ||
    approval.decisionReason ||
    neededPath ||
    approval.subject ||
    approval.detail
  )
  useNativeChatPromptCardFocus(cardRef, shouldFocus && !stacked)
  // The dock observes no box that grows with this capped content: a new countdown or detail asks it to re-fit.
  useNativeChatDockRefit(cardRef, !stacked, [
    countdown,
    approval.description,
    approval.decisionReason,
    neededPath,
    approval.subject,
    approval.detail
  ])
  const escape = onCancel ?? (isSubmitting ? undefined : onCollapse)

  return (
    <SecuritySurface>
      <div className={stacked ? 'bg-chat-pane' : 'min-h-0 shrink overflow-hidden bg-chat-pane'}>
        <div
          className={cn(
            'flex w-full px-3 pt-2 pb-1 sm:px-4',
            // Quiet: the transcript scroller's gutters too, which narrow panes show.
            quiet
              ? 'scrollbar-sleek overflow-hidden [scrollbar-gutter:stable_both-edges]'
              : 'mx-auto max-w-(--chat-content-max-width)',
            !stacked && 'h-full min-h-0 max-h-full'
          )}
        >
          {/* Quiet: laid out as the transcript column is, so the card's edges meet its rows' icon and time. */}
          <div
            className={cn(
              'flex w-full',
              quiet && 'mx-auto max-w-(--chat-content-max-width) px-[5px]',
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
              // The chat's own approval keeps its title and choices visible as the dock fits a short pane.
              data-native-chat-dock-clip={stacked ? undefined : ''}
              className={cn(
                'flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-lg border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                quiet
                  ? 'gap-1.5 border-border px-2.5 pt-1.5 pb-2'
                  : 'gap-2 border-input px-4 py-3 shadow-xs'
              )}
            >
              <div
                data-native-chat-dock-pinned={stacked ? undefined : ''}
                className={cn('flex shrink-0 items-start', quiet ? 'min-h-6 gap-1.5' : 'gap-2')}
              >
                <ShieldQuestion
                  className={cn(
                    'shrink-0',
                    quiet
                      ? 'mt-[5px] size-3.5 text-chat-foreground-faint'
                      : 'mt-0.5 size-4 text-muted-foreground'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'line-clamp-2 break-words text-sm',
                      quiet
                        ? 'font-medium leading-relaxed text-chat-foreground'
                        : 'font-semibold text-foreground'
                    )}
                  >
                    {titleContent ?? title}
                  </p>
                  {worker ? (
                    <p
                      className={cn(
                        'flex min-w-0 items-center gap-1.5 text-xs',
                        quiet ? 'text-chat-foreground-faint' : 'mt-0.5 text-muted-foreground'
                      )}
                    >
                      <span className="truncate">
                        {t('components.native-chat.approval.worker', 'Worker · {{name}}', {
                          name: worker.name
                        })}
                      </span>
                      <span aria-hidden>·</span>
                      <button
                        type="button"
                        onClick={worker.onOpen}
                        className={cn(
                          'shrink-0 rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          quiet ? 'text-chat-foreground' : 'text-foreground'
                        )}
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
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      quiet
                        ? 'text-chat-foreground-faint hover:bg-chat-foreground/5 hover:text-chat-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    )}
                  >
                    <X className={quiet ? 'size-3.5' : 'size-4'} />
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
                  // The dock fit must leave two lines of the request in view (or all of it, if shorter).
                  data-native-chat-dock-floor-lines={stacked ? undefined : 2}
                  className={cn(
                    'min-h-0 max-h-72 shrink overflow-auto text-sm scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    // Quiet: under the title, as a folded row's lines sit under its own.
                    quiet
                      ? 'space-y-1.5 pl-5 text-chat-foreground-faint'
                      : 'space-y-2 text-muted-foreground'
                  )}
                >
                  {countdown ? <p className="tabular-nums">{countdown}</p> : null}
                  {approval.description ? (
                    <p className="whitespace-pre-wrap break-words">{approval.description}</p>
                  ) : null}
                  {approval.decisionReason ? (
                    <p className="whitespace-pre-wrap break-words">
                      <span
                        className={cn(
                          'font-medium',
                          quiet ? 'text-chat-foreground' : 'text-foreground'
                        )}
                      >
                        {t('components.native-chat.approval.reason', 'Reason')}:{' '}
                      </span>
                      {approval.decisionReason}
                    </p>
                  ) : null}
                  {neededPath ? (
                    <p className="break-words">
                      <span
                        className={cn(
                          'font-medium',
                          quiet ? 'text-chat-foreground' : 'text-foreground'
                        )}
                      >
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
                  ) : quietDetailText !== null ? (
                    <>
                      <div
                        ref={quietDetailRef}
                        data-native-chat-approval-detail="true"
                        data-native-chat-code-content
                        className={cn(
                          'whitespace-pre-wrap break-words font-mono text-chat-code text-chat-code-foreground',
                          !quietDetailOpen && 'line-clamp-3'
                        )}
                      >
                        {quietDetailText}
                      </div>
                      {quietOtherArguments !== null ? (
                        <div
                          ref={quietOtherArgumentsRef}
                          className={cn(
                            'break-words font-mono text-chat-code',
                            !quietDetailOpen && 'line-clamp-2'
                          )}
                        >
                          {quietOtherArguments}
                        </div>
                      ) : null}
                    </>
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
              <div
                data-native-chat-approval-actions="true"
                data-native-chat-dock-pinned={stacked ? undefined : ''}
                className={cn('flex shrink-0 flex-wrap', quiet ? 'gap-1.5 pl-5' : 'gap-2')}
              >
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
                        'rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                        quiet
                          ? 'h-6 px-2.5 text-xs font-medium'
                          : 'px-4 py-1.5 text-sm font-semibold',
                        i === 0 && !approval.neutralOptions
                          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                          : url !== null
                            ? 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                            : quiet
                              ? 'bg-chat-foreground/5 text-chat-foreground hover:bg-chat-foreground/10'
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
                    className={cn(
                      'rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      quiet ? 'h-6 px-2.5 text-xs font-medium' : 'px-4 py-1.5 text-sm font-semibold'
                    )}
                  >
                    {t('components.native-chat.question.openTerminal', 'Answer in terminal')}
                  </button>
                ) : null}
                {showsQuietDetailToggle ? (
                  <button
                    type="button"
                    aria-expanded={quietDetailOpen}
                    onClick={() => setQuietDetailOpen(!quietDetailOpen)}
                    className="inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-xs font-medium text-chat-foreground-faint transition-colors hover:bg-chat-foreground/5 hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t('components.native-chat.notices.details', 'Details')}
                    <ChevronDown
                      className={cn('size-3.5', quietDetailOpen && 'rotate-180')}
                      aria-hidden
                    />
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </SecuritySurface>
  )
}
