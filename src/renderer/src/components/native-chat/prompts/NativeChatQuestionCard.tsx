import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatQuestionText } from './NativeChatQuestionText'
import { NativeChatQuestionOption } from './NativeChatQuestionOption'
import { CONFIRM_LABEL, NativeChatQuestionConfirmButton } from './NativeChatQuestionConfirmButton'
import {
  NativeChatQuestionCardHeader,
  nativeChatQuestionCardLabel
} from './NativeChatQuestionCardHeader'
import { NativeChatQuestionAnswerField } from './NativeChatQuestionAnswerField'
import type { AskAnswerSelection } from '../../../../../shared/native-chat/input/questions/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'
import { useNativeChatPromptCardFocus } from './use-native-chat-prompt-card-focus'
import { useNativeChatQuestionAutoAdvance } from './use-native-chat-question-auto-advance'
import { useNativeChatQuestionKeys } from './use-native-chat-question-keys'
import { useNativeChatQuestionStepHeight } from './use-native-chat-question-step-height'
import {
  useReportNativeChatQuestionDraft,
  foldNativeChatQuestionOnEscape,
  confirmNativeChatQuestionOnCardEnter,
  type NativeChatQuestionCardDraft,
  type NativeChatQuestionCardLook
} from './NativeChatQuestionCardParts'
import { useNativeChatDockRefit } from '../pane/dock/use-native-chat-dock-fit'
import type { AgentJournalFreeTextInput } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  askAcceptsEmptyAnswer,
  askConfirmAction,
  askQuestionShowsPreviews,
  askConfirmLabel,
  askTypedText,
  askUnansweredRequired,
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
  /** The caller sends only a whole answer even though it can dismiss: no "Skip and submit", and
   *  Submit with a step left open goes to that step. */
  requiresEveryAnswer?: boolean
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

/** Single-select advances after a pick; multi-select confirms explicitly, and multi-question prompts retain earlier answers. */
export function NativeChatQuestionCard({
  prompt,
  isSubmitting = false,
  isCancelling = false,
  onAnswer,
  allowOther = true,
  freeTextInputs,
  onCancel,
  requiresEveryAnswer = false,
  onCollapse,
  shouldFocus = false,
  answerInputRef,
  look,
  draft
}: NativeChatQuestionCardProps): React.JSX.Element {
  const t = useTranslate()
  const cardRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const blocked = isSubmitting || isCancelling
  const autoAdvance = useNativeChatQuestionAutoAdvance(blocked)
  const [index, setIndex] = useState(0)
  useNativeChatPromptCardFocus(cardRef, shouldFocus, index)
  useNativeChatQuestionStepHeight(surfaceRef, index)
  // Use indices because labels can repeat and the agent commits numbered rows.
  const [selections, setSelections] = useState<number[][]>(
    () => draft?.selections ?? prompt.questions.map(() => [])
  )
  const [otherText, setOtherText] = useState<string[]>(
    () =>
      draft?.otherText ?? prompt.questions.map((_, qi) => freeTextInputs?.[qi]?.initialValue ?? '')
  )
  useReportNativeChatQuestionDraft(draft, selections, otherText)
  // Holds a sent answer until the next commit, which carries the caller's own pending state;
  // after it, isSubmitting decides, so a refused, thrown or failed send leaves the card retryable.
  const latchRef = useRef(false)
  const blockedRef = useRef(blocked)
  const [attempt, setAttempt] = useState(0)
  useLayoutEffect(() => {
    latchRef.current = false
  }, [attempt])
  useLayoutEffect(() => {
    blockedRef.current = blocked
  }, [blocked])
  useNativeChatDockRefit(cardRef, true, [index])

  const total = prompt.questions.length
  const isLast = index === total - 1
  const q = prompt.questions[index]!
  const questionAllowsOther = Array.isArray(allowOther) ? (allowOther[index] ?? false) : allowOther
  const freeTextInput = freeTextInputs?.[index]
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

  const answeredAt = (qi: number, sel = selections, oth = otherText): boolean =>
    answerFor(qi, sel, oth).length > 0 || acceptsEmpty(qi)
  const currentAnswered = answeredAt(index)
  const anyAnswered = prompt.questions.some((_, i) => answeredAt(i))
  // With nothing to dismiss (an item's ask), only a whole answer goes: Submit waits for every step.
  const nothingToSend =
    !onCancel && isLast && prompt.questions.some((_, i) => !answeredAt(i))
  const confirmLabel = askConfirmLabel(currentAnswered, isLast, anyAnswered || nothingToSend)
  // A caller that needs every answer sends Submit to the open step instead of skipping it.
  const canSkipSteps = !nothingToSend && !requiresEveryAnswer
  const skipAndSubmit = confirmLabel === 'submit' && !currentAnswered && total > 1 && canSkipSteps
  const outlinedConfirm =
    skipAndSubmit || nothingToSend || (requiresEveryAnswer && !currentAnswered)
  // Submit is idle on the required question it would only return to.
  const submitBlocked =
    isLast && anyAnswered && askUnansweredRequired(prompt.questions, (i) => answeredAt(i)) === index
  const currentTypedAnswerChosen = typedAnswerChosen(index)

  const submitAll = (sel: number[][], oth: string[]): void => {
    if (latchRef.current || blockedRef.current) {
      return
    }
    const resolved: AskAnswerSelection[] = prompt.questions.map((_, i) => ({
      indices: pickedOptions(i, sel),
      other: typedAnswerChosen(i, sel, oth) ? typedText(i, oth) : ''
    }))
    const answeredSteps = resolved.map(
      (s, i) => s.indices.length > 0 || (s.other ?? '').length > 0 || acceptsEmpty(i)
    )
    // With nothing to dismiss, or a caller that needs every answer, only a whole answer goes, from
    // any path (pick, Enter, Submit): an empty step is shown instead.
    const firstEmpty = onCancel && !requiresEveryAnswer ? -1 : answeredSteps.indexOf(false)
    if (firstEmpty !== -1) {
      setIndex(firstEmpty)
    } else if (answeredSteps.some(Boolean)) {
      latchRef.current = true
      // Queued before onAnswer, so even a throwing send commits and releases the latch.
      setAttempt((value) => value + 1)
      onAnswer(resolved)
    }
  }

  // Submit from an explicit snapshot so the latest pick cannot be lost to asynchronous state updates.
  const advanceOrSubmit = (sel: number[][], oth: string[]): void => {
    if (isLast) {
      const unanswered = askUnansweredRequired(prompt.questions, (i) => answeredAt(i, sel, oth))
      if (unanswered === -1) {
        submitAll(sel, oth)
      } else {
        setIndex(unanswered)
      }
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
    if (blocked) {
      return
    }
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
    if (blocked) {
      return
    }
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
    setIndex(Math.max(0, Math.min(questionIndex, total - 1)))
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

  return (
    <div
      ref={cardRef}
      data-native-chat-prompt-card-focus={shouldFocus || undefined}
      data-native-chat-question-card
      // How many choices its digit keys pick, for a surface that sends other typing elsewhere.
      data-native-chat-question-options={q.options.length}
      role="group"
      aria-label={nativeChatQuestionCardLabel(t, q, index, total)}
      tabIndex={-1}
      // The card opens focused but must not look picked or ringed; options draw their own focus.
      className={cn('flex min-h-0 shrink flex-col bg-chat-pane outline-none', look?.frameClassName)}
      aria-busy={isSubmitting}
      onKeyDown={(event) => {
        if (!confirmNativeChatQuestionOnCardEnter(event, currentAnswered, () => confirm(true))) {
          foldNativeChatQuestionOnEscape(event, isSubmitting ? undefined : collapse)
        }
      }}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-(--chat-content-max-width) flex-col px-3 pt-2 pb-4 sm:px-4">
        <div
          ref={surfaceRef}
          data-native-chat-dock-clip
          className={cn(
            'native-chat-question-card-surface relative z-[1] flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-primary/28 bg-chat-canvas bg-[linear-gradient(var(--color-chat-composer-surface),var(--color-chat-composer-surface))] shadow-sm',
            look?.surfaceClassName
          )}
        >
          <NativeChatQuestionCardHeader
            steps={prompt.questions.map((question, i) => ({
              // Questions never reorder within a card, so their position is their identity.
              id: `question-${i}`,
              header:
                question.header ||
                t('components.native-chat.question.step', 'Step {{value0}}', { value0: i + 1 }),
              answered: answered(i)
            }))}
            index={index}
            disabled={isSubmitting}
            cancelDisabled={isCancelling}
            onGoTo={goTo}
            onCollapse={collapse}
            onCancel={cancel}
          />
          {look?.header}
          <div
            data-native-chat-dock-unsqueezed
            // Short of room (fit level card), the question, options and typed answer scroll as one body,
            // still tall enough for the question's first line and option 1, and faded while more lies below.
            className="native-chat-question-card-body scrollbar-sleek flex min-h-0 shrink flex-col [[data-native-chat-dock-fit~=card]_&]:min-h-[calc(var(--spacing)*26)] [[data-native-chat-dock-fit~=card]_&]:overflow-y-auto"
          >
            <div
              // The fit keeps two lines of the question (or all of a shorter one) in view.
              data-native-chat-dock-floor-lines={2}
              className={cn(
                // The card's heading, one step above its body text and scaling with it; it fades while more lies below.
                'native-chat-question-card-question min-h-[1lh] shrink overflow-y-auto px-3.5 text-[length:calc(var(--text-sm)*15/13)] leading-snug font-semibold text-foreground scrollbar-sleek',
                // Capped at whole lines plus its own top padding, so a long question never shows a cut line.
                total > 1
                  ? 'max-h-[calc(4lh+var(--spacing)*0.5)] pt-0.5 [[data-native-chat-dock-fit~=card]_&]:max-h-[calc(2lh+var(--spacing)*0.5)]'
                  : 'max-h-[calc(4lh+var(--spacing)*3)] pt-3 [[data-native-chat-dock-fit~=card]_&]:max-h-[calc(2lh+var(--spacing)*3)]',
                // In a scrolling body the question keeps two lines (scrolling for the rest), so option 1 starts in view.
                '[[data-native-chat-dock-fit~=card]_&]:shrink-0'
              )}
            >
              <div data-native-chat-dock-content>
                {look?.renderQuestion ? (
                  <div data-testid="native-chat-question-card-title">
                    {look.renderQuestion(q.question)}
                  </div>
                ) : (
                  <NativeChatQuestionText
                    data-testid="native-chat-question-card-title"
                    content={q.question}
                    className="break-words [&_p]:my-0 [&_p+p]:mt-2"
                  />
                )}
              </div>
            </div>
            {q.options.length > 0 ? (
              // Padded so each tile's outside focus outline clears the scroll clip.
              <div
                // The fit keeps option 1 whole before it lets the options shrink further.
                data-native-chat-dock-floor-first-item
                className={cn(
                  'native-chat-question-card-options min-h-[calc(var(--spacing)*12)] shrink-[100] overflow-y-auto px-3.5 pt-2.5 pb-1 scrollbar-sleek',
                  '[[data-native-chat-dock-fit~=card]_&]:min-h-0 [[data-native-chat-dock-fit~=card]_&]:shrink-0 [[data-native-chat-dock-fit~=card]_&]:overflow-visible'
                )}
              >
                <div data-native-chat-dock-content className="flex flex-col gap-1.5">
                  {q.options.map((opt, i) => (
                    <NativeChatQuestionOption
                      key={`${i}:${opt.label}`}
                      badge={String(i + 1)}
                      label={opt.label}
                      description={opt.description}
                      preview={opt.preview}
                      selected={(selections[index] ?? []).includes(i)}
                      disabled={isSubmitting}
                      onSelect={() => pickOption(i)}
                      onEnter={() => pickOption(i, 'enter')}
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {questionAllowsOther ? (
              <NativeChatQuestionAnswerField
                multiline={freeTextInput?.multiline === true}
                value={otherText[index] ?? ''}
                chosen={currentTypedAnswerChosen}
                disabled={isSubmitting}
                takesFocus={q.options.length === 0}
                placeholder={answerPlaceholder}
                inputRef={answerInputRef}
                onChange={(value) => setOther(index, value)}
                onPointerChoose={() => {
                  autoAdvance.cancel()
                  if ((otherText[index] ?? '').trim().length > 0) {
                    chooseTypedAnswer(index)
                  }
                }}
                onEnter={() => confirm(true)}
              />
            ) : null}
          </div>
          <div
            data-native-chat-dock-pinned
            className="native-chat-question-card-footer relative flex shrink-0 items-center gap-2 px-3.5 pt-3 pb-3.5"
          >
            {index > 0 ? (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => goTo(index - 1)}
                className="inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-[length:calc(var(--chat-ui-size,var(--text-sm))*13/14)] font-semibold text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/45 disabled:opacity-50"
              >
                {t('components.native-chat.question.back', 'Back')}
              </button>
            ) : null}
            <span className="flex-1" />
            <NativeChatQuestionConfirmButton
              label={
                isSubmitting
                  ? t('components.native-chat.question.sending', 'Sending…')
                  : skipAndSubmit
                    ? t('components.native-chat.question.skipAndSubmit', 'Skip and submit')
                    : CONFIRM_LABEL[confirmLabel]()
              }
              answered={confirmLabel !== 'skip' && !outlinedConfirm}
              enterHint={
                currentAnswered && !isSubmitting && !q.multiSelect && !freeTextInput?.multiline
              }
              disabled={blocked || nothingToSend || submitBlocked}
              onConfirm={() => confirm()}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
