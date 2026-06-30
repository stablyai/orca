import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatAskAnswer, type AskPrompt } from './native-chat-interactive-prompt'

export type NativeChatQuestionCardProps = {
  prompt: AskPrompt
  /** Send the formatted answer text to the agent. */
  onAnswer: (text: string) => void
  /** Dismiss the prompt (sends Escape to the agent). */
  onCancel: () => void
}

// Synthetic option value for the "Other…" free-text row, kept out of the
// answer text and replaced by the typed value when selected.
const OTHER = '__other__'

/**
 * Native renderer for an agent's AskUserQuestion prompt as a wizard: one
 * question per step with tabs across the top (tap to jump, a check once
 * answered), single- or multi-select option rows, an "Other…" row that reveals a
 * free-text input, and a Next button that advances and becomes "Send answer" on
 * the last step. Matches the desktop chat's neutral shadcn styling.
 */
export function NativeChatQuestionCard({
  prompt,
  onAnswer,
  onCancel
}: NativeChatQuestionCardProps): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [selections, setSelections] = useState<string[][]>(() => prompt.questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() => prompt.questions.map(() => ''))

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setSelections((prev) => {
      const next = prev.map((s) => [...s])
      const cur = next[qi] ?? []
      if (multi) {
        next[qi] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
      } else {
        next[qi] = cur.includes(label) ? [] : [label]
      }
      return next
    })
  }

  const setOther = (qi: number, value: string): void => {
    setOtherText((prev) => {
      const next = [...prev]
      next[qi] = value
      return next
    })
  }

  // The resolved answer for a question: picked labels plus the typed "Other"
  // value (which replaces the synthetic OTHER marker).
  const answerFor = (qi: number): string => {
    const picked = (selections[qi] ?? []).filter((l) => l !== OTHER)
    const other = (selections[qi] ?? []).includes(OTHER) ? (otherText[qi] ?? '').trim() : ''
    return [...picked, other].filter((p) => p.length > 0).join(', ')
  }

  const total = prompt.questions.length
  const isLast = index === total - 1
  const currentAnswered = useMemo(
    () => answerFor(index).length > 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selections, otherText, index]
  )

  const submit = (): void => {
    // Build per-question label lists, substituting the typed Other value, then
    // format to one line per answered question.
    const resolved = prompt.questions.map((_, i) => {
      const picked = (selections[i] ?? []).filter((l) => l !== OTHER)
      const other = (selections[i] ?? []).includes(OTHER) ? (otherText[i] ?? '').trim() : ''
      return [...picked, ...(other ? [other] : [])]
    })
    const text = formatAskAnswer(prompt, resolved)
    if (text.length > 0) {
      onAnswer(text)
    }
  }

  const advance = (): void => {
    if (isLast) {
      submit()
    } else {
      setIndex((i) => Math.min(i + 1, total - 1))
    }
  }

  const q = prompt.questions[index]!
  const otherSelected = (selections[index] ?? []).includes(OTHER)

  return (
    <div className="shrink-0 border-t border-border bg-muted/30">
      <div className="mx-auto flex max-h-[22rem] w-full max-w-3xl flex-col px-3 py-2 sm:px-4">
        {total > 1 ? (
          <div className="flex gap-1 overflow-x-auto border-b border-border pb-2 scrollbar-sleek">
            {prompt.questions.map((qq, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIndex(i)}
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium',
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

        <div className="min-h-0 flex-1 overflow-y-auto py-2 scrollbar-sleek">
          <p className="mb-2 text-sm font-semibold text-foreground">{q.question}</p>
          <div className="flex flex-col gap-1.5">
            {q.options.map((opt) => (
              <OptionRow
                key={opt.label}
                label={opt.label}
                description={opt.description}
                selected={(selections[index] ?? []).includes(opt.label)}
                onSelect={() => toggle(index, opt.label, q.multiSelect)}
              />
            ))}
            <OptionRow
              label={translate('components.native-chat.question.other', 'Other…')}
              selected={otherSelected}
              onSelect={() => toggle(index, OTHER, q.multiSelect)}
            />
            {otherSelected ? (
              <textarea
                autoFocus
                value={otherText[index]}
                onChange={(e) => setOther(index, e.target.value)}
                placeholder={translate(
                  'components.native-chat.question.otherPlaceholder',
                  'Type your answer'
                )}
                rows={2}
                className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              />
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {translate('components.native-chat.question.cancel', 'Cancel')}
          </button>
          {total > 1 ? (
            <span className="text-xs text-muted-foreground">
              {index + 1}/{total}
            </span>
          ) : null}
          <button
            type="button"
            onClick={advance}
            disabled={!currentAnswered}
            className={cn(
              'rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-colors',
              'hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            {isLast
              ? translate('components.native-chat.question.send', 'Send answer')
              : translate('components.native-chat.question.next', 'Next')}
          </button>
        </div>
      </div>
    </div>
  )
}

function OptionRow({
  label,
  description,
  selected,
  onSelect
}: {
  label: string
  description?: string
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-md border bg-background px-3 py-2 text-left transition-colors',
        selected ? 'border-primary' : 'border-border hover:bg-accent/50'
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground'
        )}
      >
        {selected ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {description ? (
          <span className="block text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
    </button>
  )
}
