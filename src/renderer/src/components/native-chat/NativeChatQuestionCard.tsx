import { Fragment, useState, type RefObject } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { AskAnswerSelection, AskPrompt } from './native-chat-interactive-prompt'

export type NativeChatQuestionCardProps = {
  prompt: AskPrompt
  /** Whether the snapshotted answer is still being delivered to the agent. */
  isSubmitting?: boolean
  /** Deliver the chosen answer (per-question option indices + free text). */
  onAnswer: (selections: AskAnswerSelection[]) => void
  allowOther?: boolean | readonly boolean[]
  /** Dismiss the prompt (sends Escape to the agent). */
  onCancel: () => void
  /** Exposes the free-text row so pane-level Paste can target it while the
   *  card replaces the composer. */
  answerInputRef?: RefObject<HTMLInputElement | null>
}

/**
 * Native renderer for an agent's AskUserQuestion prompt: a numbered pick-list
 * (mobile/Claude-Code parity) with a header + close, a hover-highlighted row per
 * option, and an optional free-text row for a custom answer. Single-select
 * commits on click; multi-select toggles and confirms via the trailing action.
 * Multi-question prompts step through tabs across the top. Neutral shadcn tokens.
 */
export function NativeChatQuestionCard({
  prompt,
  isSubmitting = false,
  onAnswer,
  allowOther = true,
  onCancel,
  answerInputRef
}: NativeChatQuestionCardProps): React.JSX.Element {
  const [index, setIndex] = useState(0)
  // Keep option identity by index: labels are display text and are not guaranteed
  // unique, while Claude's selector commits the numbered row (STA-1860).
  const [selections, setSelections] = useState<number[][]>(() => prompt.questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() => prompt.questions.map(() => ''))
  // Which option's preview is showing, per question. Pointer and keyboard focus
  // both write it, so hovering a row previews it without committing a pick.
  const [highlights, setHighlights] = useState<number[]>(() => prompt.questions.map(() => 0))

  const total = prompt.questions.length
  const isLast = index === total - 1
  const q = prompt.questions[index]!
  const questionAllowsOther = Array.isArray(allowOther) ? (allowOther[index] ?? false) : allowOther

  const setHighlight = (optionIndex: number): void => {
    setHighlights((prev) => {
      const next = [...prev]
      next[index] = optionIndex
      return next
    })
  }

  const previewIndex = highlights[index] ?? 0
  const preview = q.options[previewIndex]?.preview
  // Gated on preview text rather than `hasPreview`: this decides whether there is
  // anything to render, not which keystrokes the answer commits with.
  const questionHasPreviewText = q.options.some((option) => (option.preview ?? '').length > 0)

  const setOther = (qi: number, value: string): void => {
    setOtherText((prev) => {
      const next = [...prev]
      next[qi] = value
      return next
    })
  }

  // The resolved answer for a question: picked labels plus any typed free-text.
  const answerFor = (qi: number, sel = selections, oth = otherText): string => {
    const question = prompt.questions[qi]
    const picked = (sel[qi] ?? [])
      .map((optionIndex) => question?.options[optionIndex]?.label ?? '')
      .filter((label) => label.length > 0)
    const other = (oth[qi] ?? '').trim()
    return [...picked, ...(other ? [other] : [])].join(', ')
  }

  const currentPicked = (selections[index] ?? []).length > 0
  const currentAnswered = answerFor(index).length > 0

  const submitAll = (sel: number[][], oth: string[]): void => {
    const resolved: AskAnswerSelection[] = prompt.questions.map((_, i) => {
      return { indices: [...(sel[i] ?? [])], other: (oth[i] ?? '').trim() }
    })
    const anyAnswered = resolved.some((s) => s.indices.length > 0 || (s.other ?? '').length > 0)
    if (anyAnswered) {
      onAnswer(resolved)
    }
  }

  // Advance to the next question, or submit on the last one — always from an
  // explicit snapshot so a just-committed single-select pick isn't lost to the
  // async setState.
  const advanceOrSubmit = (sel: number[][], oth: string[]): void => {
    if (isLast) {
      submitAll(sel, oth)
    } else {
      setIndex((i) => Math.min(i + 1, total - 1))
    }
  }

  // Selecting only highlights the row; submitting is an explicit step via the
  // trailing Send/Next button. (Auto-submitting on the first click dismissed the
  // card before the user saw any feedback, which read as "nothing happened".)
  const pickOption = (optionIndex: number): void => {
    setHighlight(optionIndex)
    setSelections((prev) => {
      const next = prev.map((s) => [...s])
      const cur = next[index] ?? []
      if (q.multiSelect) {
        next[index] = cur.includes(optionIndex)
          ? cur.filter((pickedIndex) => pickedIndex !== optionIndex)
          : [...cur, optionIndex].sort((a, b) => a - b)
      } else {
        next[index] = cur.includes(optionIndex) ? [] : [optionIndex]
      }
      return next
    })
  }

  // Trailing action (also fired by Enter). On any non-final question this just
  // advances — "Next" when answered, "Skip" when not — so skipping one question
  // never discards answers already given on the others. Only the final question
  // submits; an explicit Skip click there with nothing answered anywhere
  // dismisses, but a reflexive Enter in the empty field is a no-op so it can't
  // throw away the whole prompt.
  const confirm = (fromKeyboard = false): void => {
    if (!isLast) {
      advanceOrSubmit(selections, otherText)
      return
    }
    const anyAnswered = prompt.questions.some((_, i) => answerFor(i).length > 0)
    if (anyAnswered) {
      submitAll(selections, otherText)
    } else if (!fromKeyboard) {
      onCancel()
    }
  }

  return (
    // Part of the composer: docked in the bottom input region, matching the
    // composer's width and padding, rendered as the "ask" dialog card directly
    // above the text input. Its free-text row is the answer input.
    <div className="shrink-0 bg-background" aria-busy={isSubmitting}>
      <div className="mx-auto w-full max-w-4xl px-3 pt-2 pb-4 sm:px-4">
        {total > 1 ? (
          <div className="mb-2 flex gap-1 overflow-x-auto pb-1 scrollbar-sleek">
            {prompt.questions.map((qq, i) => (
              <button
                key={i}
                type="button"
                disabled={isSubmitting}
                onClick={() => setIndex(i)}
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
          <div className="flex items-start justify-between gap-2 px-3.5 py-2.5">
            <p className="min-w-0 break-words text-sm font-semibold text-foreground">
              {q.question}
            </p>
            <button
              type="button"
              onClick={onCancel}
              aria-label={translate('components.native-chat.question.cancel', 'Cancel')}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* The card is width-constrained by the chat pane, not the window, so
              the split is driven by the card's own inline size. */}
          <div className="@container/question border-t border-border">
            {/* Scroll only kicks in on long option lists; the sleek scrollbar rides
                the card's right edge instead of crowding the choices. One grid in
                both modes: stacked, the preview is the row after its own option;
                split, it spans column 2 across every option row.

                The row track list is explicit because `row-span-full` resolves
                against explicit lines only — with implicit rows the span collapses
                to one row, which then stretches to the preview's height. */}
            <div
              style={
                questionHasPreviewText
                  ? ({
                      '--question-option-rows': `repeat(${q.options.length}, min-content)`
                    } as React.CSSProperties)
                  : undefined
              }
              className={cn(
                'grid max-h-[50vh] min-w-0 grid-cols-1 auto-rows-min overflow-y-auto scrollbar-sleek',
                questionHasPreviewText &&
                  '@2xl/question:grid-cols-2 @2xl/question:grid-rows-(--question-option-rows) @2xl/question:content-start @2xl/question:[&>button]:col-start-1 @2xl/question:[&>[data-slot=question-preview]]:col-start-2 @2xl/question:[&>[data-slot=question-preview]]:row-span-full'
              )}
            >
              {q.options.map((opt, i) => (
                <Fragment key={`${i}:${opt.label}`}>
                  <OptionRow
                    badge={String(i + 1)}
                    label={opt.label}
                    description={opt.description}
                    selected={(selections[index] ?? []).includes(i)}
                    highlighted={questionHasPreviewText && previewIndex === i}
                    disabled={isSubmitting}
                    onSelect={() => pickOption(i)}
                    onHighlight={() => setHighlight(i)}
                    dividerAbove={i > 0}
                  />
                  {questionHasPreviewText && previewIndex === i ? (
                    <PreviewPanel preview={preview} />
                  ) : null}
                </Fragment>
              ))}
            </div>
            <div className="flex items-center gap-3 border-t border-border/60 px-3.5 py-2.5">
              {questionAllowsOther ? (
                <>
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Pencil className="size-3.5" />
                  </span>
                  <input
                    ref={answerInputRef}
                    disabled={isSubmitting}
                    value={otherText[index]}
                    onChange={(e) => setOther(index, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        confirm(true)
                      }
                    }}
                    placeholder={
                      !questionHasPreviewText
                        ? translate(
                            'components.native-chat.question.otherPlaceholder',
                            'Type your answer'
                          )
                        : currentPicked
                          ? translate(
                              'components.native-chat.question.notePlaceholder',
                              'Add a note (optional)'
                            )
                          : translate(
                              'components.native-chat.question.replyPlaceholder',
                              'Answer in your own words — sends as a chat message'
                            )
                    }
                    className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-default disabled:opacity-50"
                  />
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

/** The highlighted option's example snippet, rendered as markdown in a monospace
 *  box to match the AskUserQuestion tool's documented contract for the field.
 *  Beside the option list it is a framed well; stacked under one option it is a
 *  flush detail region indented to that option's text column. Carries no
 *  disclosure affordance in either mode — the highlight follows hover, so
 *  anything that read as expandable would invite a click that does nothing. */
function PreviewPanel({ preview }: { preview?: string }): React.JSX.Element {
  return (
    <div
      data-slot="question-preview"
      // Stacked, the left inset lands on the option label's text column (row
      // border + padding + badge + gap), past the number badge.
      className="min-w-0 self-stretch pr-3.5 pb-2.5 pl-13 @2xl/question:relative @2xl/question:h-full @2xl/question:border-l @2xl/question:border-border/60 @2xl/question:pt-2.5 @2xl/question:pl-3.5"
    >
      {/* Beside the list the well is lifted out of flow, so which preview is
          showing cannot feed back into the grid's track sizing — swapping
          previews must not resize the card. */}
      <div className="min-w-0 overflow-hidden bg-muted/40 @2xl/question:absolute @2xl/question:inset-x-3.5 @2xl/question:inset-y-2.5 @2xl/question:rounded-md @2xl/question:border @2xl/question:border-border/60">
        {preview ? (
          <CommentMarkdown
            content={preview}
            className={cn(
              'max-h-[40vh] overflow-auto p-2.5 font-mono text-xs text-foreground scrollbar-sleek @2xl/question:max-h-full',
              // The compact variant emits paragraphs as inline spans and caps its
              // own code blocks; blocking the spans keeps line structure, and
              // releasing the cap lets this frame's height tier govern scrolling.
              '[&_.comment-md-p]:block [&_.comment-md-p+.comment-md-p]:mt-2',
              '[&_pre]:my-1 [&_pre]:max-h-none [&_pre]:bg-transparent [&_pre]:p-0 [&_pre]:text-xs',
              '[&_code]:text-xs'
            )}
          />
        ) : (
          <p className="p-2.5 text-xs text-muted-foreground">
            {translate('components.native-chat.question.noPreview', 'This option has no preview.')}
          </p>
        )}
      </div>
    </div>
  )
}

function OptionRow({
  badge,
  label,
  description,
  selected,
  highlighted,
  disabled,
  onSelect,
  onHighlight,
  dividerAbove
}: {
  badge: string
  label: string
  description?: string
  selected: boolean
  highlighted: boolean
  disabled: boolean
  onSelect: () => void
  onHighlight: () => void
  dividerAbove: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      onMouseEnter={onHighlight}
      onFocus={onHighlight}
      // Selection is otherwise only the visual check/badge swap; expose it to
      // assistive tech.
      aria-pressed={selected}
      className={cn(
        // The inline left border is transparent when idle so the row's text
        // never shifts as the highlight moves.
        'flex w-full items-start gap-3 border-l-2 border-l-transparent px-3.5 py-2.5 text-left transition-colors disabled:pointer-events-none',
        // Grid children cannot use the list's divide-y once the preview splits
        // into a second column.
        dividerAbove && 'border-t border-border/60',
        selected || highlighted ? 'bg-accent' : 'hover:bg-accent',
        // Ties the row to the preview it drives, which is otherwise a full-height
        // cell beside the whole list.
        highlighted && 'border-l-ring'
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
        <span className="block break-words text-sm text-foreground">{label}</span>
        {description ? (
          <span className="block break-words text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
    </button>
  )
}
