import { ImeInput } from '@/lib/ime-text-field'
import { Textarea } from '@/components/ui/textarea'
import { useRef, useState, type RefObject } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AskAnswerSelection, AskPrompt } from './native-chat-interactive-prompt'
import { NativeChatPromptCollapseToggle } from './NativeChatPromptCollapse'
import { useNativeChatPromptCardFocus } from './use-native-chat-prompt-card-focus'
import { useNativeChatQuestionAutoAdvance } from './use-native-chat-question-auto-advance'
import { useNativeChatQuestionKeys } from './use-native-chat-question-keys'
import { isEditableTarget } from '@/lib/editable-target'
import type { AgentJournalFreeTextInput } from '../../../../shared/agent-session-journal-types'

export type NativeChatQuestionCardProps = {
  prompt: AskPrompt
  /** Whether the snapshotted answer is still being delivered to the agent. */
  isSubmitting?: boolean
  isCancelling?: boolean
  /** Deliver the chosen answer (per-question option indices + free text). */
  onAnswer: (selections: AskAnswerSelection[]) => void
  allowOther?: boolean | readonly boolean[]
  freeTextInputs?: readonly (AgentJournalFreeTextInput | undefined)[]
  /** Dismiss the prompt (sends Escape to the agent). */
  onCancel: () => void
  /** Fold the card to a strip and give the input back, writing nothing; Escape does too. */
  onCollapse?: () => void
  /** Take focus when the card takes the input region; number keys pick while it holds. */
  shouldFocus?: boolean
  /** Paste target while the card replaces the composer. */
  answerInputRef?: RefObject<HTMLInputElement | null>
}

// Reserve a non-option index so single-select holds either an option or typed text.
const TYPED_ANSWER = -1

/** Single-select advances after a pick; multi-select confirms explicitly, and multi-question prompts retain earlier answers. */
export function NativeChatQuestionCard({
  prompt,
  isSubmitting = false,
  isCancelling = false,
  onAnswer,
  allowOther = true,
  freeTextInputs,
  onCancel,
  onCollapse,
  shouldFocus = false,
  answerInputRef
}: NativeChatQuestionCardProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const autoAdvance = useNativeChatQuestionAutoAdvance()
  const [index, setIndex] = useState(0)
  useNativeChatPromptCardFocus(cardRef, shouldFocus, index)
  // Use indices because labels can repeat and the agent commits numbered rows.
  const [selections, setSelections] = useState<number[][]>(() => prompt.questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() =>
    prompt.questions.map((_, qi) => freeTextInputs?.[qi]?.initialValue ?? '')
  )

  const total = prompt.questions.length
  const isLast = index === total - 1
  const q = prompt.questions[index]!
  const questionAllowsOther = Array.isArray(allowOther) ? (allowOther[index] ?? false) : allowOther
  const freeTextInput = freeTextInputs?.[index]
  const fieldTakesFocus = q.options.length === 0 || undefined
  const answerPlaceholder =
    freeTextInput?.placeholder ??
    translate('components.native-chat.question.otherPlaceholder', 'Type your answer')
  const acceptsEmpty = (qi: number): boolean =>
    freeTextInputs?.[qi]?.allowEmpty === true && prompt.questions[qi]?.options.length === 0
  const typedText = (qi: number, oth = otherText): string =>
    freeTextInputs?.[qi]?.allowEmpty ? (oth[qi] ?? '') : (oth[qi] ?? '').trim()

  // Picking an option deselects typed text without erasing it from the field.
  const typedAnswerChosen = (qi: number, sel = selections, oth = otherText): boolean =>
    acceptsEmpty(qi) || ((sel[qi] ?? []).includes(TYPED_ANSWER) && typedText(qi, oth).length > 0)

  const chooseTypedAnswer = (qi: number): void => {
    setSelections((prev) => {
      const cur = prev[qi] ?? []
      if (cur.includes(TYPED_ANSWER)) {
        return prev
      }
      const chosen = prompt.questions[qi]?.multiSelect ? [...cur, TYPED_ANSWER] : [TYPED_ANSWER]
      return prev.map((s, i) => (i === qi ? chosen : s))
    })
  }

  const pickedOptions = (qi: number, sel = selections): number[] =>
    (sel[qi] ?? []).filter((choice) => choice !== TYPED_ANSWER)

  const setOther = (qi: number, value: string): void => {
    autoAdvance.cancel()
    setOtherText((prev) => {
      const next = [...prev]
      next[qi] = value
      return next
    })
    if (value.trim().length > 0) {
      chooseTypedAnswer(qi)
    }
  }

  const answerFor = (qi: number, sel = selections, oth = otherText): string => {
    const question = prompt.questions[qi]
    const picked = pickedOptions(qi, sel)
      .map((optionIndex) => question?.options[optionIndex]?.label ?? '')
      .filter((label) => label.length > 0)
    const other = typedAnswerChosen(qi, sel, oth) ? typedText(qi, oth) : ''
    return [...picked, ...(other ? [other] : [])].join(', ')
  }

  const currentAnswered = answerFor(index).length > 0 || acceptsEmpty(index)
  const currentTypedAnswerChosen = typedAnswerChosen(index)

  const submitAll = (sel: number[][], oth: string[]): void => {
    const resolved: AskAnswerSelection[] = prompt.questions.map((_, i) => {
      return {
        indices: pickedOptions(i, sel),
        other: typedAnswerChosen(i, sel, oth) ? typedText(i, oth) : ''
      }
    })
    const anyAnswered = resolved.some(
      (s, i) => s.indices.length > 0 || (s.other ?? '').length > 0 || acceptsEmpty(i)
    )
    if (anyAnswered) {
      onAnswer(resolved)
    }
  }

  // Submit from an explicit snapshot so the latest pick cannot be lost to asynchronous state updates.
  const advanceOrSubmit = (sel: number[][], oth: string[]): void => {
    if (isLast) {
      submitAll(sel, oth)
    } else {
      setIndex((i) => Math.min(i + 1, total - 1))
    }
  }

  // Briefly show a single-select pick before advancing; picking again retracts it.
  const pickOption = (optionIndex: number): void => {
    const cur = selections[index] ?? []
    const picked = !cur.includes(optionIndex)
    const chosen = !picked
      ? cur.filter((pickedIndex) => pickedIndex !== optionIndex)
      : q.multiSelect
        ? [...cur, optionIndex].sort((a, b) => a - b)
        : [optionIndex]
    const next = selections.map((s, i) => (i === index ? chosen : s))
    setSelections(next)
    autoAdvance.cancel()
    if (picked && !q.multiSelect) {
      autoAdvance.schedule(() => advanceOrSubmit(next, otherText))
    }
  }
  useNativeChatQuestionKeys(cardRef, shouldFocus && !isSubmitting, q.options.length, pickOption)

  // Only the final question submits; an empty final Skip dismisses, while empty Enter preserves the prompt.
  const confirm = (fromKeyboard = false): void => {
    autoAdvance.cancel()
    if (!isLast) {
      advanceOrSubmit(selections, otherText)
      return
    }
    const anyAnswered = prompt.questions.some((_, i) => answerFor(i).length > 0 || acceptsEmpty(i))
    if (anyAnswered) {
      submitAll(selections, otherText)
    } else if (!fromKeyboard) {
      onCancel()
    }
  }

  // Leaving the question by any other route drops a pending auto-advance.
  const goTo = (questionIndex: number): void => {
    autoAdvance.cancel()
    setIndex(questionIndex)
  }
  const cancel = (): void => {
    autoAdvance.cancel()
    onCancel()
  }
  const collapse = onCollapse
    ? (): void => {
        autoAdvance.cancel()
        onCollapse()
      }
    : undefined

  return (
    <div
      ref={cardRef}
      data-native-chat-prompt-card-focus={shouldFocus || undefined}
      role="group"
      aria-label={q.question}
      tabIndex={-1}
      className="shrink-0 bg-chat-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-busy={isSubmitting}
      onKeyDown={(event) => {
        // Why not from a text field: Escape there is editing, and collapsing would hide the draft.
        if (
          event.key === 'Escape' &&
          !event.nativeEvent.isComposing &&
          collapse &&
          !isSubmitting &&
          !isEditableTarget(event.target)
        ) {
          event.preventDefault()
          event.stopPropagation()
          collapse()
        }
      }}
    >
      <div className="mx-auto w-full max-w-(--chat-content-max-width) px-3 pt-2 pb-4 sm:px-4">
        {total > 1 ? (
          <div className="mb-2 flex gap-1 overflow-x-auto pb-1 scrollbar-sleek">
            {prompt.questions.map((qq, i) => (
              <button
                key={i}
                type="button"
                disabled={isSubmitting}
                onClick={() => goTo(i)}
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium disabled:pointer-events-none',
                  i === index
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span className="max-w-[10rem] truncate">
                  {qq.header ||
                    translate('components.native-chat.question.step', 'Step {{value0}}', {
                      value0: i + 1
                    })}
                </span>
                {answerFor(i).length > 0 ? (
                  <Check className="size-3 text-primary" strokeWidth={3} />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-lg border border-input bg-card shadow-xs">
          <div className="flex items-start gap-2 px-3.5 py-2.5">
            <p
              data-testid="native-chat-question-card-title"
              className="min-w-0 flex-1 break-words text-sm font-semibold text-foreground"
            >
              {q.question}
            </p>
            {collapse ? (
              <NativeChatPromptCollapseToggle
                expanded
                disabled={isSubmitting}
                onToggle={collapse}
              />
            ) : null}
            <button
              type="button"
              onClick={cancel}
              disabled={isCancelling}
              aria-label={translate('components.native-chat.question.cancel', 'Cancel')}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="max-h-[50vh] divide-y divide-border/60 overflow-y-auto border-t border-border scrollbar-sleek">
            {q.options.map((opt, i) => (
              <OptionRow
                key={`${i}:${opt.label}`}
                badge={String(i + 1)}
                initialFocus={i === 0}
                label={opt.label}
                description={opt.description}
                selected={(selections[index] ?? []).includes(i)}
                disabled={isSubmitting}
                onSelect={() => pickOption(i)}
              />
            ))}
            <div className="flex items-center gap-3 px-3.5 py-2.5">
              {questionAllowsOther ? (
                <>
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-md',
                      currentTypedAnswerChosen
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {currentTypedAnswerChosen ? (
                      <Check className="size-3.5" strokeWidth={3} />
                    ) : (
                      <Pencil className="size-3.5" />
                    )}
                  </span>
                  {/* Deliver free text verbatim as a tool result; composer slash commands and autocomplete do not apply. */}
                  {freeTextInput?.multiline ? (
                    <Textarea
                      data-native-chat-prompt-card-focus-target={fieldTakesFocus}
                      disabled={isSubmitting}
                      value={otherText[index]}
                      onChange={(e) => setOther(index, e.target.value)}
                      onClick={autoAdvance.cancel}
                      placeholder={answerPlaceholder}
                    />
                  ) : (
                    <ImeInput
                      ref={answerInputRef}
                      data-native-chat-answer-field
                      data-native-chat-prompt-card-focus-target={fieldTakesFocus}
                      disabled={isSubmitting}
                      value={otherText[index]}
                      onChange={(e) => setOther(index, e.target.value)}
                      // Select typed text on click; tabbing toward Submit must not replace a picked option.
                      onClick={() => {
                        autoAdvance.cancel()
                        if ((otherText[index] ?? '').trim().length > 0) {
                          chooseTypedAnswer(index)
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          confirm(true)
                        }
                      }}
                      placeholder={answerPlaceholder}
                      className={cn(
                        'min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 disabled:cursor-default disabled:opacity-50',
                        currentTypedAnswerChosen || !otherText[index]
                          ? 'text-foreground'
                          : 'text-muted-foreground'
                      )}
                    />
                  )}
                </>
              ) : (
                <span className="flex-1" />
              )}
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => confirm()}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50',
                  currentAnswered
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                )}
              >
                {isSubmitting
                  ? translate('components.native-chat.question.sending', 'Sending…')
                  : currentAnswered
                    ? isLast
                      ? translate('components.native-chat.question.send', 'Submit')
                      : translate('components.native-chat.question.next', 'Next')
                    : translate('components.native-chat.question.skip', 'Skip')}
              </button>
            </div>
          </div>
        </div>

        {total > 1 ? (
          <p className="mt-2 text-right text-xs text-muted-foreground">
            {index + 1}/{total}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function OptionRow({
  badge,
  initialFocus,
  label,
  description,
  selected,
  disabled,
  onSelect
}: {
  badge: string
  initialFocus: boolean
  label: string
  description?: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={selected}
      data-native-chat-prompt-card-focus-target={initialFocus || undefined}
      className={cn(
        'group/option flex w-full items-start gap-3 px-3.5 py-2.5 text-left text-foreground transition-colors focus:bg-accent focus:text-accent-foreground focus:outline-none disabled:pointer-events-none',
        selected
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-accent hover:text-accent-foreground'
      )}
    >
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-medium',
          selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
        )}
      >
        {selected ? <Check className="size-3.5" strokeWidth={3} /> : badge}
      </span>
      <span className="min-w-0">
        <span className="block break-words text-sm">{label}</span>
        {description ? (
          <span
            className={cn(
              'block break-words text-xs',
              selected
                ? 'text-accent-foreground'
                : 'text-muted-foreground group-hover/option:text-accent-foreground group-focus/option:text-accent-foreground'
            )}
          >
            {description}
          </span>
        ) : null}
      </span>
    </button>
  )
}
