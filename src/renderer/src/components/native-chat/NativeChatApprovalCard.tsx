import { NativeChatForm } from './NativeChatForm'
import type { AgentSessionFormContent } from '../../../../shared/agent-session-form'
import { SecuritySurface } from '@/components/ui/security-surface'
import { useId, useRef } from 'react'
import { ShieldQuestion, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { approvalBlockedPathToShow } from '../../../../shared/agent-session-approval-blocked-path'
import {
  isNewerApprovalSubject,
  isPlanApprovalSubject
} from '../../../../shared/agent-session-approval-subject'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import type { ChatApproval } from '../../../../shared/native-chat-interactive-prompt'
import { NativeChatPromptCollapseToggle } from './NativeChatPromptCollapse'
import { useNativeChatPromptCardFocus } from './use-native-chat-prompt-card-focus'
import { Button } from '@/components/ui/button'

export type NativeChatApprovalCardProps = {
  approval: ChatApproval
  /** Deliver the option's transport-specific response token. */
  onChoose: (option: string) => void
  /** Cancel the active provider turn while this card owns the composer region. */
  onCancel?: () => void
  /** Without `onCancel`: fold the card to a strip and give the input back, writing nothing. */
  onCollapse?: () => void
  /** A choice is being delivered: the options wait for its answer. */
  formSubmitEnabled?: boolean
  isSubmitting?: boolean
  shouldFocus?: boolean
  /** A plan body renders as markdown; these make its file paths clickable. */
  onLinkClick?: CommentMarkdownLinkClickHandler
  onOpenUrl?: (url: string) => void
  onSubmitForm?: (content: AgentSessionFormContent) => void
  allowFileUriLinks?: boolean
}

const optionClassName = (primary: boolean): string =>
  cn(
    'rounded-md px-4 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
    primary
      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
      : 'border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground'
  )

/** PTY options are literal replies; structured options are journal ids. Style the first option, or a form's Submit, as primary. */
export function NativeChatApprovalCard({
  approval,
  onChoose,
  onOpenUrl,
  onSubmitForm,
  onCancel,
  onCollapse,
  formSubmitEnabled = true,
  isSubmitting = false,
  shouldFocus = false,
  onLinkClick,
  allowFileUriLinks = false
}: NativeChatApprovalCardProps): React.JSX.Element {
  useUiLanguageRevision()
  const cardRef = useRef<HTMLDivElement>(null)
  const formId = useId()
  const neededPath = approvalBlockedPathToShow(approval)
  // A newer Orca's subject: its detail is shown, and only the card's cancel answers.
  const newerSubject = isNewerApprovalSubject(approval.subject)
  const hasContext = Boolean(
    approval.description ||
    approval.decisionReason ||
    neededPath ||
    approval.subject ||
    approval.detail
  )
  useNativeChatPromptCardFocus(cardRef, shouldFocus)
  const escape = onCancel ?? (isSubmitting ? undefined : onCollapse)

  return (
    <SecuritySurface>
      <div className="min-h-0 shrink overflow-hidden bg-chat-canvas">
        <div className="mx-auto flex h-full min-h-0 max-h-full w-full max-w-(--chat-content-max-width) px-3 pt-2 pb-1 sm:px-4">
          <div
            ref={cardRef}
            data-native-chat-prompt-card-focus={shouldFocus || undefined}
            data-native-chat-approval-card="true"
            role="group"
            aria-label={approval.title}
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
                data-native-chat-approval-content="true"
                tabIndex={0}
                className="min-h-0 max-h-72 shrink space-y-2 overflow-auto text-sm text-muted-foreground scrollbar-sleek focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {approval.description ? (
                  <p className="whitespace-pre-wrap break-words">{approval.description}</p>
                ) : null}
                {approval.decisionReason ? (
                  <p className="whitespace-pre-wrap break-words">
                    <span className="font-medium text-foreground">
                      {translate('components.native-chat.approval.reason', 'Reason')}:{' '}
                    </span>
                    {approval.decisionReason}
                  </p>
                ) : null}
                {neededPath ? (
                  <p className="break-words">
                    <span className="font-medium text-foreground">
                      {translate('components.native-chat.approval.needsAccess', 'Needs access to')}
                      :{' '}
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
                      {...(onLinkClick ? { onLinkClick } : {})}
                      allowFileUriLinks={allowFileUriLinks}
                      linkifyFilePaths={onLinkClick !== undefined}
                    />
                    {approval.subject.filePath ? (
                      <p className="mt-2 break-all">
                        <span className="font-medium text-foreground">
                          {translate('components.native-chat.approval.plan.file', 'Plan file')}
                          :{' '}
                        </span>
                        <span className="font-mono">{approval.subject.filePath}</span>
                      </p>
                    ) : null}
                  </div>
                ) : approval.detail ? (
                  <div
                    data-native-chat-approval-detail="true"
                    data-native-chat-code-content
                    className="whitespace-pre-wrap break-words font-mono text-chat-code"
                  >
                    {approval.detail}
                  </div>
                ) : null}
                {newerSubject ? (
                  <p data-native-chat-approval-needs-newer-orca="true" className="break-words">
                    {translate(
                      'components.native-chat.approval.needsNewerOrca',
                      'This request needs a newer version of Orca.'
                    )}
                  </p>
                ) : null}
              </div>
            ) : null}
            {approval.form && onSubmitForm && !newerSubject ? (
              <NativeChatForm
                id={formId}
                form={approval.form}
                disabled={isSubmitting}
                submitDisabled={!formSubmitEnabled}
                onSubmit={onSubmitForm}
              />
            ) : null}
            <div data-native-chat-approval-actions="true" className="flex shrink-0 flex-wrap gap-2">
              {approval.form && onSubmitForm && !newerSubject ? (
                <button
                  type="submit"
                  form={formId}
                  disabled={isSubmitting || !formSubmitEnabled}
                  className={optionClassName(true)}
                >
                  {translate('components.native-chat.question.send', 'Submit')}
                </button>
              ) : null}
              {approval.url && onOpenUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={() => approval.url && onOpenUrl(approval.url)}
                >
                  {translate('components.native-chat.approval.openLink', 'Open link')}
                </Button>
              ) : null}
              {approval.options.map((opt, i) => (
                <button
                  key={`${opt.label}-${i}`}
                  type="button"
                  disabled={newerSubject || isSubmitting}
                  onClick={() => onChoose(opt.send)}
                  className={optionClassName(i === 0 && !approval.form)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </SecuritySurface>
  )
}
