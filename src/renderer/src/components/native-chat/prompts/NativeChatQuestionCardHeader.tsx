import { Check, ChevronLeft, ChevronRight, MessageCircleQuestionMark, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatPromptCollapseToggle } from './NativeChatPromptCollapse'

export type NativeChatQuestionStep = { header: string; answered: boolean }

/** The card's band: what is being asked, where in a multi-step card, and fold/cancel; then the step bar. */
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
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const total = steps.length
  const current = steps[index]!
  const stepLabel = (step: NativeChatQuestionStep): string =>
    step.answered
      ? t('components.native-chat.question.stepAnswered', '{{value0}}, answered', {
          value0: step.header
        })
      : step.header
  return (
    <>
      <div
        data-native-chat-dock-pinned
        className="flex min-h-9 shrink-0 items-center gap-1.5 bg-primary/9 py-1 pr-1.5 pl-3.5 text-xs font-semibold text-foreground"
      >
        <MessageCircleQuestionMark aria-hidden className="size-3.5 shrink-0 text-primary" />
        {total > 1 ? (
          <>
            <span className="min-w-0 truncate">{current.header}</span>
            <span className="shrink-0 font-medium whitespace-nowrap text-muted-foreground">
              {'· '}
              {t('components.native-chat.question.stepOf', '{{value0}} of {{value1}}', {
                value0: index + 1,
                value1: total
              })}
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
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onCancel}
          disabled={cancelDisabled}
          aria-label={t('components.native-chat.question.cancel', 'Cancel')}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>
      {total > 1 ? (
        // Each segment's hit area is its padded button; the 4px bar inside is only the picture.
        <div data-native-chat-dock-pinned className="flex shrink-0 gap-[3px] px-3.5">
          {steps.map((step, i) => (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-native-chat-question-step
                  aria-label={stepLabel(step)}
                  aria-current={i === index ? 'step' : undefined}
                  disabled={disabled}
                  onClick={() => onGoTo(i)}
                  className="group/step flex-1 py-2.5 focus-visible:outline-none disabled:pointer-events-none"
                >
                  <span
                    className={cn(
                      'block h-1 rounded-full transition-colors group-focus-visible/step:outline-[1.5px] group-focus-visible/step:outline-offset-2 group-focus-visible/step:outline-foreground/45 group-focus-visible/step:outline-solid',
                      i === index
                        ? 'bg-primary'
                        : step.answered
                          ? 'bg-foreground/40 group-hover/step:bg-foreground/55'
                          : 'bg-foreground/12 group-hover/step:bg-foreground/25'
                    )}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={2}>
                {stepLabel(step)}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : null}
    </>
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
      variant="ghost"
      size="icon-xs"
      data-native-chat-question-step
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="text-muted-foreground"
    >
      {children}
    </Button>
  )
}
