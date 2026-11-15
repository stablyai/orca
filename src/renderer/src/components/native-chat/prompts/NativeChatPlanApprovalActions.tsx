import { useState, type RefObject } from 'react'
import { Check, Loader2, Pencil } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import type { ChatApproval } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { useNativeChatApprovalKeys } from './use-native-chat-approval-keys'

const LINE_BREAKS = /[\r\n\u2028\u2029]/g

export function NativeChatPlanApprovalActions({
  cardRef,
  options,
  neutralOptions,
  freeTextInput,
  newerSubject,
  isSubmitting,
  submittingOption,
  shouldFocus,
  stacked,
  isPlanChoices,
  onOpenTerminal,
  onChoose
}: {
  cardRef: RefObject<HTMLDivElement | null>
  options: ChatApproval['options']
  neutralOptions?: boolean
  freeTextInput?: ChatApproval['freeTextInput']
  newerSubject: boolean
  isSubmitting: boolean
  submittingOption?: string
  shouldFocus: boolean
  stacked: boolean
  isPlanChoices: boolean
  onOpenTerminal?: () => void
  onChoose: (option: string, feedback?: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [feedbackText, setFeedbackText] = useState(() => freeTextInput?.initialValue ?? '')
  const [submittedWithFeedback, setSubmittedWithFeedback] = useState(false)

  const feedbackOption = options.find((opt) => opt.intent === 'reject_once')
  const feedbackInput = !newerSubject && freeTextInput && feedbackOption ? freeTextInput : undefined
  const trimmedFeedback = feedbackText.trim()
  const hasFeedback = trimmedFeedback.length > 0
  const feedbackPlaceholder =
    feedbackInput?.placeholder ??
    t('components.native-chat.approval.plan.otherPlaceholder', 'Type what to change in the plan…')

  const chooseOption = (option: string): void => {
    setSubmittedWithFeedback(false)
    onChoose(option)
  }

  const submitFeedback = (): void => {
    if (!feedbackOption || !hasFeedback || isSubmitting || newerSubject) {
      return
    }
    setSubmittedWithFeedback(true)
    onChoose(feedbackOption.send, trimmedFeedback)
  }

  useNativeChatApprovalKeys({
    cardRef,
    enabled: shouldFocus && !stacked && !isSubmitting && isPlanChoices,
    options,
    onChooseOption: chooseOption
  })

  return (
    <div
      data-native-chat-approval-actions="true"
      className={cn(
        'flex shrink-0',
        isPlanChoices || feedbackInput ? 'flex-col gap-2' : 'flex-wrap gap-2'
      )}
    >
      {isPlanChoices ? (
        <div className="flex flex-col gap-1.5">
          {options.map((opt, i) => (
            <div
              key={`${opt.label}-${i}`}
              className="rounded-[10px] border border-question-option-border transition-colors has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-inset has-[>button:focus-visible]:ring-chat-focus-ring"
            >
              <button
                type="button"
                disabled={newerSubject || isSubmitting}
                data-native-chat-approval-option
                data-native-chat-prompt-card-focus-target={i === 0 || undefined}
                onClick={() => chooseOption(opt.send)}
                className="flex w-full items-center gap-3 rounded-[9px] px-3 py-2 text-left text-foreground transition-colors hover:bg-foreground/5 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex size-5.5 shrink-0 items-center justify-center rounded-md border text-xs font-medium',
                    i === 0 && !neutralOptions
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-question-option-border text-foreground'
                  )}
                >
                  {isSubmitting && !submittedWithFeedback && opt.send === submittingOption ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm font-medium">{opt.label}</span>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((opt, i) => (
            <button
              key={`${opt.label}-${i}`}
              type="button"
              disabled={newerSubject || isSubmitting}
              onClick={() => chooseOption(opt.send)}
              className={cn(
                'rounded-md px-4 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
                i === 0 && !neutralOptions
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              {isSubmitting && !submittedWithFeedback && opt.send === submittingOption ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {opt.label}
                </span>
              ) : (
                opt.label
              )}
            </button>
          ))}
          {options.length === 0 && onOpenTerminal ? (
            <button
              type="button"
              onClick={onOpenTerminal}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('components.native-chat.question.openTerminal', 'Answer in terminal')}
            </button>
          ) : null}
        </div>
      )}
      {feedbackInput && feedbackOption ? (
        <div className={cn('flex gap-2.5', feedbackInput.multiline ? 'items-end' : 'items-center')}>
          <div
            className={cn(
              'flex min-h-9 min-w-0 flex-1 gap-3 rounded-[10px] border border-question-option-border px-2.5 py-1.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-chat-focus-ring',
              feedbackInput.multiline ? 'items-start' : 'items-center'
            )}
          >
            <span
              aria-hidden
              className={cn(
                'flex size-5.5 shrink-0 items-center justify-center rounded-md border',
                hasFeedback
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-question-option-border text-muted-foreground'
              )}
            >
              {hasFeedback ? (
                <Check className="size-3.5" strokeWidth={3} />
              ) : (
                <Pencil className="size-3.5" />
              )}
            </span>
            <ImeTextarea
              rows={feedbackInput.multiline ? undefined : 1}
              data-native-chat-answer-field
              disabled={isSubmitting}
              value={feedbackText}
              onChange={(e) => {
                if (feedbackInput.multiline) {
                  setFeedbackText(e.target.value)
                  return
                }
                const field = e.target
                const oneLine = field.value.replace(LINE_BREAKS, ' ')
                if (oneLine !== field.value) {
                  const { selectionStart, selectionEnd } = field
                  field.value = oneLine
                  field.setSelectionRange(selectionStart, selectionEnd)
                }
                setFeedbackText(oneLine)
              }}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.nativeEvent.isComposing &&
                  !e.repeat &&
                  (feedbackInput.multiline
                    ? (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
                    : !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)
                ) {
                  e.preventDefault()
                  submitFeedback()
                }
              }}
              placeholder={feedbackPlaceholder}
              aria-label={feedbackPlaceholder}
              className={
                feedbackInput.multiline
                  ? 'scrollbar-sleek max-h-[8lh] min-h-12 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent [field-sizing:content] text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-default disabled:opacity-50'
                  : 'scrollbar-sleek max-h-[6lh] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent [field-sizing:content] text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-default disabled:opacity-50'
              }
            />
          </div>
          <button
            type="button"
            disabled={!hasFeedback || isSubmitting}
            onClick={submitFeedback}
            className={cn(
              'inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border px-3.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-chat-focus-ring disabled:cursor-default disabled:opacity-50',
              hasFeedback
                ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                : 'border-question-option-border text-foreground hover:bg-foreground/5'
            )}
          >
            {isSubmitting && submittedWithFeedback ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {t('components.native-chat.approval.plan.sendFeedback', 'Submit')}
              </span>
            ) : (
              t('components.native-chat.approval.plan.sendFeedback', 'Submit')
            )}
          </button>
        </div>
      ) : null}
    </div>
  )
}
