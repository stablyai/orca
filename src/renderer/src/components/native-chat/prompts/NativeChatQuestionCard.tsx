import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { useRef, useState, type RefObject } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatQuestionText } from './NativeChatQuestionText'
import { NativeChatQuestionOption } from './NativeChatQuestionOption'
import { NativeChatQuestionConfirmButton } from './NativeChatQuestionConfirmButton'
import type { AskAnswerSelection } from '../../../../../shared/native-chat/input/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../shared/native-chat/input/native-chat-ask-types'
import { NativeChatPromptCollapseToggle } from './NativeChatPromptCollapse'
import { useNativeChatPromptCardFocus } from './use-native-chat-prompt-card-focus'
import { useNativeChatQuestionAutoAdvance } from './use-native-chat-question-auto-advance'
import { useNativeChatQuestionKeys } from './use-native-chat-question-keys'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import type { AgentJournalFreeTextInput } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  askAcceptsEmptyAnswer,
  askConfirmAction,
  askQuestionShowsPreviews,
  askConfirmLabel,
  askTypedText,
  toggleAskOption
} from '../../../../../shared/native-chat/input/native-chat-ask-card-rules'

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
  answerInputRef?: RefObject<HTMLTextAreaElement | null>
}

// Reserve a non-option index so single-select holds either an option or typed text.
const TYPED_ANSWER = -1
const LINE_BREAKS = /[\r\n\u2028\u2029]/g

const CONFIRM_LABEL = {
  submit: () => translate('components.native-chat.question.send', 'Submit'),
  next: () => translate('components.native-chat.question.next', 'Next'),
  skip: () => translate('components.native-chat.question.skip', 'Skip')
} as const

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
  const t = useTranslate()
  const cardRef = useRef<HTMLDivElement>(null)
  const autoAdvance = useNativeChatQuestionAutoAdvance(isSubmitting || isCancelling)
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
  const showsPreviews = askQuestionShowsPreviews(q)
  const answerPlaceholder =
    freeTextInput?.placeholder ??
    t('components.native-chat.question.otherPlaceholder', 'Type your answer')
  const acceptsEmpty = (qi: number): boolean =>
    askAcceptsEmptyAnswer(prompt.questions[qi], freeTextInputs?.[qi])
  const typedText = (qi: number, oth = otherText): string =>
    askTypedText(oth[qi] ?? '', freeTextInputs?.[qi])

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

  // Briefly show a single-select pick before advancing; clicking it again retracts it, while Enter on
  // the chosen row confirms. With previews, a pick stays put and a digit only focuses its row.
  const pickOption = (
    optionIndex: number,
    via: 'pointer' | 'digit' | 'enter' = 'pointer'
  ): void => {
    const cur = selections[index] ?? []
    // Focus first, so Enter after any digit acts on the row that digit named.
    if (showsPreviews && via === 'digit') {
      cardRef.current
        ?.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
        [optionIndex]?.focus()
    }
    // Enter on a chosen single-select row does what the footer says (Next/Submit), never deselects.
    if (cur.includes(optionIndex) && (showsPreviews || (via === 'enter' && !q.multiSelect))) {
      if (via === 'enter') {
        confirm(true)
      }
      return
    }
    const picked = !cur.includes(optionIndex)
    const chosen = toggleAskOption(cur, optionIndex, q.multiSelect)
    const next = selections.map((s, i) => (i === index ? chosen : s))
    setSelections(next)
    autoAdvance.cancel()
    if (picked && !q.multiSelect && !showsPreviews) {
      autoAdvance.schedule(() => advanceOrSubmit(next, otherText))
    }
  }

  const confirm = (fromKeyboard = false): void => {
    autoAdvance.cancel()
    const anyAnswered = prompt.questions.some((_, i) => answerFor(i).length > 0 || acceptsEmpty(i))
    const action = askConfirmAction({ isLast, anyAnswered, fromKeyboard })
    if (action === 'proceed') {
      advanceOrSubmit(selections, otherText)
    } else if (action === 'cancel') {
      onCancel()
    }
  }

  // Leaving the question by any other route drops a pending auto-advance.
  const goTo = (questionIndex: number): void => {
    autoAdvance.cancel()
    setIndex(questionIndex)
  }
  useNativeChatQuestionKeys(
    cardRef,
    shouldFocus && !isSubmitting,
    q.options.length,
    pickOption,
    (delta) => {
      const next = index + delta
      if (next < 0 || next >= total) {
        return false
      }
      goTo(next)
      return true
    }
  )
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
      className="shrink-0 bg-chat-pane focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
                data-native-chat-question-step
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
                    t('components.native-chat.question.step', 'Step {{value0}}', {
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

        {/* One 14px gutter (px-3.5) for the question, option tiles and footer, so their edges line up. */}
        <div className="overflow-hidden rounded-[14px] border border-question-card-border bg-chat-composer-surface shadow-sm">
          <div className="flex items-start gap-2 px-3.5 py-2.5">
            <NativeChatQuestionText
              data-testid="native-chat-question-card-title"
              content={q.question}
              className="min-w-0 flex-1 break-words text-sm font-medium text-foreground [&_p]:my-0 [&_p+p]:mt-2"
            />
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
              aria-label={t('components.native-chat.question.cancel', 'Cancel')}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* Option rings are inset, so the scroll clip cannot cut them. */}
          <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto px-3.5 pb-3 scrollbar-sleek">
            {q.options.map((opt, i) => (
              <NativeChatQuestionOption
                key={`${i}:${opt.label}`}
                badge={String(i + 1)}
                initialFocus={i === 0}
                label={opt.label}
                description={opt.description}
                preview={opt.preview}
                selected={(selections[index] ?? []).includes(i)}
                disabled={isSubmitting}
                onSelect={() => pickOption(i)}
              />
            ))}
          </div>
          <div
            className={cn(
              'flex gap-2.5 px-3.5 pb-3.5',
              freeTextInput?.multiline ? 'items-end' : 'items-center'
            )}
          >
            {questionAllowsOther ? (
              <div
                className={cn(
                  'flex min-h-9 min-w-0 flex-1 gap-3 rounded-[10px] border border-question-option-border px-2.5 py-1.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-chat-focus-ring',
                  freeTextInput?.multiline ? 'items-start' : 'items-center'
                )}
              >
                <span
                  className={cn(
                    'flex size-5.5 shrink-0 items-center justify-center rounded-md border',
                    currentTypedAnswerChosen
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-question-option-border text-muted-foreground'
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
                  // The box draws the field's edge, so the bare field (not the bordered Textarea primitive) sits inside it.
                  <ImeTextarea
                    data-native-chat-answer-field
                    data-native-chat-prompt-card-focus-target={fieldTakesFocus}
                    disabled={isSubmitting}
                    value={otherText[index]}
                    onChange={(e) => setOther(index, e.target.value)}
                    onClick={autoAdvance.cancel}
                    placeholder={answerPlaceholder}
                    className="scrollbar-sleek max-h-[12lh] min-h-16 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent [field-sizing:content] text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-default disabled:opacity-50"
                  />
                ) : (
                  <ImeTextarea
                    ref={answerInputRef}
                    rows={1}
                    data-native-chat-answer-field
                    data-native-chat-prompt-card-focus-target={fieldTakesFocus}
                    disabled={isSubmitting}
                    value={otherText[index]}
                    // Enter submits, so a line break becomes a space; edit in place so a mid-draft paste keeps the caret.
                    onChange={(e) => {
                      const field = e.target
                      const oneLine = field.value.replace(LINE_BREAKS, ' ')
                      if (oneLine !== field.value) {
                        const { selectionStart, selectionEnd } = field
                        field.value = oneLine
                        field.setSelectionRange(selectionStart, selectionEnd)
                      }
                      setOther(index, oneLine)
                    }}
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
                      'scrollbar-sleek max-h-[6lh] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground disabled:cursor-default disabled:opacity-50',
                      currentTypedAnswerChosen || !otherText[index]
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                    )}
                  />
                )}
              </div>
            ) : (
              <span className="flex-1" />
            )}
            <NativeChatQuestionConfirmButton
              label={
                isSubmitting
                  ? t('components.native-chat.question.sending', 'Sending…')
                  : CONFIRM_LABEL[askConfirmLabel(currentAnswered, isLast)]()
              }
              answered={currentAnswered}
              enterHint={
                currentAnswered && !isSubmitting && !q.multiSelect && !freeTextInput?.multiline
              }
              disabled={isSubmitting}
              onConfirm={() => confirm()}
            />
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
