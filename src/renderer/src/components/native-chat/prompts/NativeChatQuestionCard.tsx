import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { useRef, useState, type RefObject } from 'react'
import { Check, Pencil } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatQuestionCardHeader } from './NativeChatQuestionCardHeader'
import { NativeChatQuestionOption, NativeChatQuestionOptions } from './NativeChatQuestionOption'
import { NativeChatQuestionConfirmButton } from './NativeChatQuestionConfirmButton'
import {
  NativeChatQuestionSteps,
  useReportNativeChatQuestionDraft,
  foldNativeChatQuestionOnEscape,
  type NativeChatQuestionCardDraft,
  type NativeChatQuestionCardLook
} from './NativeChatQuestionCardParts'
import type { AskAnswerSelection } from '../../../../../shared/native-chat/input/questions/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'
import { useNativeChatPromptCardFocus } from './use-native-chat-prompt-card-focus'
import { useNativeChatQuestionAutoAdvance } from './use-native-chat-question-auto-advance'
import { useNativeChatQuestionKeys } from './use-native-chat-question-keys'
import type { AgentJournalFreeTextInput } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  askAcceptsEmptyAnswer,
  askConfirmAction,
  askQuestionShowsPreviews,
  askConfirmLabel,
  askTypedText,
  toggleAskOption
} from '../../../../../shared/native-chat/input/questions/native-chat-ask-card-rules'

export type NativeChatQuestionCardProps = {
  prompt: AskPrompt
  /** Whether the snapshotted answer is still being delivered to the agent. */
  isSubmitting?: boolean
  isCancelling?: boolean
  /** Deliver the chosen answer (per-question option indices + free text). */
  onAnswer: (selections: AskAnswerSelection[]) => void
  allowOther?: boolean | readonly boolean[]
  freeTextInputs?: readonly (AgentJournalFreeTextInput | undefined)[]
  /** Dismiss the prompt (sends Escape to the agent). Without it (an item's question has nothing
   *  to dismiss) the card has no ×, and an unanswered last step shows Submit, off, instead of Skip. */
  onCancel?: () => void
  /** Fold the card to a strip and give the input back, writing nothing; Escape does too. */
  onCollapse?: () => void
  /** Take focus when the card takes the input region; number keys pick while it holds. */
  shouldFocus?: boolean
  /** Paste target while the card replaces the composer. */
  answerInputRef?: RefObject<HTMLTextAreaElement | null>
  /** Another surface's own look for the card (an item page's open question). */
  look?: NativeChatQuestionCardLook
  draft?: NativeChatQuestionCardDraft
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
  answerInputRef,
  look,
  draft
}: NativeChatQuestionCardProps): React.JSX.Element {
  const t = useTranslate()
  const cardRef = useRef<HTMLDivElement>(null)
  const autoAdvance = useNativeChatQuestionAutoAdvance(isSubmitting || isCancelling)
  const [index, setIndex] = useState(0)
  useNativeChatPromptCardFocus(cardRef, shouldFocus, index)
  // Use indices because labels can repeat and the agent commits numbered rows.
  const [selections, setSelections] = useState<number[][]>(
    () => draft?.selections ?? prompt.questions.map(() => [])
  )
  const [otherText, setOtherText] = useState<string[]>(
    () =>
      draft?.otherText ?? prompt.questions.map((_, qi) => freeTextInputs?.[qi]?.initialValue ?? '')
  )
  useReportNativeChatQuestionDraft(draft, selections, otherText)

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
  const anyAnswered = prompt.questions.some((_, i) => answerFor(i).length > 0 || acceptsEmpty(i))
  // With nothing to dismiss (an item's ask), only a whole answer goes: Submit waits for every step.
  const nothingToSend =
    !onCancel && isLast && prompt.questions.some((_, i) => !answerFor(i) && !acceptsEmpty(i))
  const confirmLabel = askConfirmLabel(currentAnswered, isLast, anyAnswered || nothingToSend)
  const currentTypedAnswerChosen = typedAnswerChosen(index)

  const submitAll = (sel: number[][], oth: string[]): void => {
    const resolved: AskAnswerSelection[] = prompt.questions.map((_, i) => ({
      indices: pickedOptions(i, sel),
      other: typedAnswerChosen(i, sel, oth) ? typedText(i, oth) : ''
    }))
    const answered = resolved.map(
      (s, i) => s.indices.length > 0 || (s.other ?? '').length > 0 || acceptsEmpty(i)
    )
    // With nothing to dismiss, only a whole answer goes, from any path (pick, Enter, Submit): an
    // empty step is shown instead.
    const firstEmpty = onCancel ? -1 : answered.indexOf(false)
    if (firstEmpty !== -1) {
      setIndex(firstEmpty)
    } else if (answered.some(Boolean)) {
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
    const action = askConfirmAction({ isLast, anyAnswered, fromKeyboard })
    if (action === 'proceed') {
      advanceOrSubmit(selections, otherText)
    } else if (action === 'cancel') {
      onCancel?.()
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
  const cancel = onCancel
    ? (): void => {
        autoAdvance.cancel()
        onCancel()
      }
    : undefined
  const collapse = onCollapse
    ? (): void => {
        autoAdvance.cancel()
        onCollapse()
      }
    : undefined
  const stepsInSurface = look?.stepsInSurface === true
  const steps = (className?: string): React.JSX.Element => (
    <NativeChatQuestionSteps
      questions={prompt.questions}
      current={index}
      answered={prompt.questions.map((_, i) => answerFor(i).length > 0)}
      disabled={isSubmitting}
      onStep={goTo}
      className={className}
    />
  )

  return (
    <div
      ref={cardRef}
      data-native-chat-prompt-card-focus={shouldFocus || undefined}
      // How many choices its digit keys pick, for a surface that sends other typing elsewhere.
      data-native-chat-question-options={q.options.length}
      role="group"
      aria-label={q.question}
      tabIndex={-1}
      // Capped against the chat pane (not the window) so the words that led to the question stay in view.
      className={cn(
        'flex max-h-[max(14rem,min(32rem,50%))] min-h-0 shrink-0 flex-col bg-chat-pane focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        look?.frameClassName
      )}
      aria-busy={isSubmitting}
      onKeyDown={(event) =>
        foldNativeChatQuestionOnEscape(event, isSubmitting ? undefined : collapse)
      }
    >
      <div className="mx-auto flex min-h-0 w-full max-w-(--chat-content-max-width) flex-col px-3 pt-2 pb-4 sm:px-4">
        {total > 1 && !stepsInSurface ? steps() : null}

        {/* One 14px gutter (px-3.5) for the question, option tiles and footer, so their edges line up.
            The box scrolls as a last resort, when a tall typed answer outgrows the pane's cap. */}
        <div
          data-native-chat-question-surface
          className={cn(
            'flex min-h-0 flex-col overflow-y-auto rounded-[14px] border border-question-card-border bg-chat-composer-surface shadow-sm scrollbar-sleek',
            look?.surfaceClassName
          )}
        >
          {/* Question and options scroll together; only the answer row stays pinned, so a short pane still reaches every option. */}
          <div className="min-h-24 shrink overflow-y-auto scrollbar-sleek">
            {look?.header}
            {total > 1 && stepsInSurface ? (
              <div className="flex items-center gap-2 px-3.5 pt-2">
                {steps('mb-0 min-w-0 shrink')}
                <span className="ml-auto shrink-0 pb-1 text-xs tabular-nums text-muted-foreground">
                  {index + 1}/{total}
                </span>
              </div>
            ) : null}
            <NativeChatQuestionCardHeader
              question={q.question}
              isSubmitting={isSubmitting}
              isCancelling={isCancelling}
              onCollapse={collapse}
              onCancel={cancel}
              renderQuestion={look?.renderQuestion}
            />

            {/* Option rings are inset, so the scroll clip cannot cut them. */}
            <NativeChatQuestionOptions multiSelect={q.multiSelect}>
              {q.options.map((opt, i) => (
                <NativeChatQuestionOption
                  key={`${i}:${opt.label}`}
                  badge={String(i + 1)}
                  multiSelect={q.multiSelect}
                  initialFocus={i === 0}
                  label={opt.label}
                  description={opt.description}
                  preview={opt.preview}
                  selected={(selections[index] ?? []).includes(i)}
                  disabled={isSubmitting}
                  onSelect={() => pickOption(i)}
                  onEnter={() => pickOption(i, 'enter')}
                />
              ))}
            </NativeChatQuestionOptions>
          </div>
          <div
            className={cn(
              'flex shrink-0 gap-2.5 px-3.5 pb-3.5',
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
                  : CONFIRM_LABEL[confirmLabel]()
              }
              answered={confirmLabel !== 'skip' && !nothingToSend}
              enterHint={
                currentAnswered && !isSubmitting && !q.multiSelect && !freeTextInput?.multiline
              }
              disabled={isSubmitting || nothingToSend}
              onConfirm={() => confirm()}
            />
          </div>
        </div>

        {total > 1 && !stepsInSurface ? (
          <p className="mt-2 shrink-0 text-right text-xs text-muted-foreground">
            {index + 1}/{total}
          </p>
        ) : null}
      </div>
    </div>
  )
}
