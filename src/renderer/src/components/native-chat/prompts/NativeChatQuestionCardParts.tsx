// Pieces of the question card: another surface's look and draft for it, its step tabs for a several-question prompt, and Escape to fold it.
import { useEffect, useEffectEvent } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import { useTranslate } from '@/i18n/use-translate'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'

/** Another surface's own look for the question card. */
export type NativeChatQuestionCardLook = {
  /** The outer frame, where the surface's fill and gutter differ from chat's. */
  frameClassName?: string
  /** Emphasis on the bordered body. */
  surfaceClassName?: string
  /** A line above the question inside the body (who asks, and that it waits on you). */
  header?: React.ReactNode
  /** Draws the question's words in place of the plain heading (an item clamps a long ask). */
  renderQuestion?: (content: string) => React.ReactNode
  /** Several steps' tabs and count sit inside the bordered body, not above and below it. */
  stepsInSurface?: boolean
}

/** An answer in progress the card starts from and reports back to, kept by its surface across remounts
 *  (an item's ask keeps the owner's picks and words until they send or recover them). */
export type NativeChatQuestionCardDraft = {
  selections: number[][]
  otherText: string[]
  onChange: (selections: number[][], otherText: string[]) => void
}

/** Reports the card's picks and words to its draft as they change. */
export function useReportNativeChatQuestionDraft(
  draft: NativeChatQuestionCardDraft | undefined,
  selections: number[][],
  otherText: string[]
): void {
  const report = useEffectEvent(() => draft?.onChange(selections, otherText))
  useEffect(() => report(), [selections, otherText])
}

/** Escape folds the card, unless it comes from a text field: Escape there is editing, and folding would
 *  hide the draft. */
export function foldNativeChatQuestionOnEscape(
  event: React.KeyboardEvent,
  collapse: (() => void) | undefined
): void {
  if (
    event.key === 'Escape' &&
    !event.nativeEvent.isComposing &&
    collapse &&
    !isEditableTarget(event.target)
  ) {
    event.preventDefault()
    event.stopPropagation()
    collapse()
  }
}

export function NativeChatQuestionSteps({
  questions,
  current,
  answered,
  disabled,
  onStep,
  className
}: {
  questions: AskPrompt['questions']
  current: number
  /** Per question: whether it holds an answer, which its tab checks. */
  answered: readonly boolean[]
  disabled: boolean
  onStep: (index: number) => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className={cn('mb-2 flex shrink-0 gap-1 overflow-x-auto pb-1 scrollbar-sleek', className)}>
      {questions.map((qq, i) => (
        <button
          key={i}
          type="button"
          data-native-chat-question-step
          aria-current={i === current ? 'step' : undefined}
          disabled={disabled}
          onClick={() => onStep(i)}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium disabled:pointer-events-none',
            i === current
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <span className="max-w-[10rem] truncate">
            {qq.header ||
              t('components.native-chat.question.step', 'Step {{value0}}', {
                value0: i + 1
              })}
          </span>
          {answered[i] ? <Check className="size-3 text-primary" strokeWidth={3} /> : null}
        </button>
      ))}
    </div>
  )
}
