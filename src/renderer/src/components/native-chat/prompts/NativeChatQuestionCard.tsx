import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatQuestionText } from './NativeChatQuestionText'
import { NativeChatQuestionOption } from './NativeChatQuestionOption'
import { NativeChatQuestionConfirmButton } from './NativeChatQuestionConfirmButton'
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
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import { invalidateNativeChatDockFit } from '../pane/dock/native-chat-dock-fit'
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
  const surfaceRef = useRef<HTMLDivElement>(null)
  const blocked = isSubmitting || isCancelling
  const autoAdvance = useNativeChatQuestionAutoAdvance(blocked)
  const [index, setIndex] = useState(0)
  useNativeChatPromptCardFocus(cardRef, shouldFocus, index)
  useNativeChatQuestionStepHeight(surfaceRef, index)
  // Use indices because labels can repeat and the agent commits numbered rows.
  const [selections, setSelections] = useState<number[][]>(() => prompt.questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() =>
    prompt.questions.map((_, qi) => freeTextInputs?.[qi]?.initialValue ?? '')
  )
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
  useLayoutEffect(() => {
    if (cardRef.current) {
      invalidateNativeChatDockFit(cardRef.current)
    }
  }, [index])

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

  const answered = (qi: number): boolean => answerFor(qi).length > 0 || acceptsEmpty(qi)
  const currentAnswered = answered(index)
  const anyAnswered = prompt.questions.some((_, i) => answered(i))
  const confirmLabel = askConfirmLabel(currentAnswered, isLast, anyAnswered)
  const skipAndSubmit = confirmLabel === 'submit' && !currentAnswered && total > 1
  const currentTypedAnswerChosen = typedAnswerChosen(index)

  const submitAll = (sel: number[][], oth: string[]): void => {
    if (latchRef.current || blockedRef.current) {
      return
    }
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
      latchRef.current = true
      // Queued before onAnswer, so even a throwing send commits and releases the latch.
      setAttempt((value) => value + 1)
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
      onCancel()
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
      data-native-chat-queue-dock
      data-native-chat-question-card
      role="group"
      aria-label={nativeChatQuestionCardLabel(t, q, index, total)}
      tabIndex={-1}
      // The card opens focused but must not look picked or ringed; options draw their own focus.
      className="flex min-h-0 shrink flex-col bg-chat-pane outline-none"
      aria-busy={isSubmitting}
      onKeyDown={(event) => {
        const modified =
          event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat
        // Enter on the card itself confirms an answered step; a child's own Enter never lands here as target.
        if (
          event.key === 'Enter' &&
          event.target === event.currentTarget &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing &&
          !modified
        ) {
          event.preventDefault()
          if (currentAnswered) {
            confirm(true)
          }
          return
        }
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
      <div className="mx-auto flex min-h-0 w-full max-w-(--chat-content-max-width) flex-col px-3 pt-2 pb-4 sm:px-4">
        {/* One 14px gutter (px-3.5) for the question, option tiles and footer, so their edges line up.
            An opaque canvas under the translucent surface keeps the tucked queue tab from showing through. */}
        <div
          ref={surfaceRef}
          data-native-chat-dock-clip
          className="relative z-[1] flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-primary/28 bg-chat-canvas bg-[linear-gradient(var(--color-chat-composer-surface),var(--color-chat-composer-surface))] shadow-sm"
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
          <div
            data-native-chat-dock-unsqueezed
            // Short of room (fit level card), the question, options and typed answer scroll as one body,
            // still tall enough for the question's first line and option 1, and faded while more lies below.
            className="native-chat-question-card-body scrollbar-sleek flex min-h-0 shrink flex-col [[data-native-chat-dock-fit~=card]_&]:min-h-[calc(var(--spacing)*26)] [[data-native-chat-dock-fit~=card]_&]:overflow-y-auto"
          >
            <div
              className={cn(
                // The card's heading, one step above its body text and scaling with it.
                'min-h-[1lh] shrink overflow-y-auto px-3.5 text-[length:calc(var(--text-sm)*15/13)] leading-snug font-semibold text-foreground scrollbar-sleek',
                'max-h-[calc(4lh+var(--spacing)*3)]',
                total > 1 ? 'pt-0.5' : 'pt-3',
                '[[data-native-chat-dock-fit~=card]_&]:max-h-none [[data-native-chat-dock-fit~=card]_&]:shrink-0 [[data-native-chat-dock-fit~=card]_&]:overflow-visible'
              )}
            >
              <div data-native-chat-dock-content>
                <NativeChatQuestionText
                  data-testid="native-chat-question-card-title"
                  content={q.question}
                  className="break-words [&_p]:my-0 [&_p+p]:mt-2"
                />
              </div>
            </div>
            {q.options.length > 0 ? (
              // Padded so each tile's outside focus outline clears the scroll clip.
              <div
                className={cn(
                  'min-h-[calc(var(--spacing)*12)] shrink-[100] overflow-y-auto px-3.5 pt-2.5 pb-1 scrollbar-sleek',
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
            className="flex shrink-0 items-center gap-2 px-3.5 pt-3 pb-3.5"
          >
            {index > 0 ? (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => goTo(index - 1)}
                className="inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-[length:calc(var(--chat-ui-size,var(--text-sm))*13/14)] font-semibold text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-foreground/45 disabled:opacity-50"
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
              answered={confirmLabel !== 'skip' && !skipAndSubmit}
              enterHint={
                currentAnswered && !isSubmitting && !q.multiSelect && !freeTextInput?.multiline
              }
              disabled={blocked}
              onConfirm={() => confirm()}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
