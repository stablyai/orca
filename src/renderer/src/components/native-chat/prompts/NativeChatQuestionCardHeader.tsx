import { Check, ChevronLeft, ChevronRight, MessageCircleQuestionMark, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'
import { NativeChatPromptCollapseToggle } from './NativeChatPromptCollapse'

/** The card's accessible name: on a multi-step card, which step it is before the question. */
export function nativeChatQuestionCardLabel(
  t: Translate,
  question: AskPrompt['questions'][number],
  index: number,
  total: number
): string {
  if (total <= 1) {
    return question.question
  }
  return t(
    'components.native-chat.question.stepLabel',
    '{{value0}}, {{value1}} of {{value2}}: {{value3}}',
    {
      value0:
        question.header ||
        t('components.native-chat.question.step', 'Step {{value0}}', { value0: index + 1 }),
      value1: index + 1,
      value2: total,
      value3: question.question
    }
  )
}

export type NativeChatQuestionStep = { header: string; answered: boolean }

/** The card's band: what is being asked, where in a multi-step card, and fold/cancel. */
export function NativeChatQuestionCardHeader({
  steps,
  index,
  disabled,
  cancelDisabled,
  onGoTo,
  onCollapse,
  onCancel
}: {
  steps: readonly NativeChatQuestionStep[]
  index: number
  disabled: boolean
  cancelDisabled: boolean
  onGoTo: (index: number) => void
  onCollapse?: () => void
  /** Without it (nothing to dismiss) there is no ×. */
  onCancel?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const total = steps.length
  const current = steps[index]!
  return (
    <div
      data-native-chat-dock-pinned
      // Its icon buttons take the options' focus outline, not the shared ring.
      className="flex min-h-9 shrink-0 items-center gap-1.5 bg-primary/9 py-1 pr-1.5 pl-3.5 text-xs font-semibold text-foreground [&_button:focus-visible]:ring-0 [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-foreground/45 [&_button:focus-visible]:outline-solid"
    >
      <MessageCircleQuestionMark aria-hidden className="size-3.5 shrink-0 text-primary" />
      {total > 1 ? (
        <>
          {/* One run: only the title shrinks, and the count stays right after it. */}
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="min-w-0 truncate">{current.header}</span>
            <span className="shrink-0 font-medium whitespace-nowrap text-muted-foreground">
              {'· '}
              {t('components.native-chat.question.stepOf', '{{value0}} of {{value1}}', {
                value0: index + 1,
                value1: total
              })}
            </span>
          </span>
          {current.answered ? (
            <Check
              aria-label={t('components.native-chat.question.answered', 'Answered')}
              className="size-3 shrink-0 text-status-success"
              strokeWidth={3}
            />
          ) : null}
        </>
      ) : (
        <span className="min-w-0 truncate">
          {t('components.native-chat.question.title', 'Question')}
        </span>
      )}
      <span className="flex-1" />
      {total > 1 ? (
        <>
          <StepButton
            label={t('components.native-chat.question.previous', 'Previous question')}
            disabled={disabled || index === 0}
            onClick={() => onGoTo(index - 1)}
          >
            <ChevronLeft />
          </StepButton>
          <StepButton
            label={t('components.native-chat.question.nextQuestion', 'Next question')}
            disabled={disabled || index === total - 1}
            onClick={() => onGoTo(index + 1)}
          >
            <ChevronRight />
          </StepButton>
        </>
      ) : null}
      {onCollapse ? (
        <NativeChatPromptCollapseToggle expanded disabled={disabled} onToggle={onCollapse} />
      ) : null}
      {onCancel ? (
        <Button
          type="button"
          variant="muted-field-icon"
          size="icon-xs"
          onClick={onCancel}
          disabled={cancelDisabled}
          aria-label={t('components.native-chat.question.cancel', 'Cancel')}
        >
          <X />
        </Button>
      ) : null}
    </div>
  )
}

function StepButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="muted-field-icon"
      size="icon-xs"
      data-native-chat-question-step
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}
