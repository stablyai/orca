import { Check } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { AskQuestion } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'

/** The step strip above a multi-question card: one chip per question, checked once answered. */
export function NativeChatQuestionSteps({
  questions,
  index,
  answered,
  disabled,
  onSelect
}: {
  questions: readonly AskQuestion[]
  index: number
  answered: (questionIndex: number) => boolean
  disabled: boolean
  onSelect: (questionIndex: number) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mb-2 flex gap-1 overflow-x-auto pb-1 scrollbar-sleek">
      {questions.map((question, i) => (
        <button
          key={i}
          type="button"
          data-native-chat-question-step
          disabled={disabled}
          onClick={() => onSelect(i)}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium disabled:pointer-events-none',
            i === index
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <span className="max-w-[10rem] truncate">
            {question.header ||
              t('components.native-chat.question.step', 'Step {{value0}}', {
                value0: i + 1
              })}
          </span>
          {answered(i) ? <Check className="size-3 text-primary" strokeWidth={3} /> : null}
        </button>
      ))}
    </div>
  )
}
