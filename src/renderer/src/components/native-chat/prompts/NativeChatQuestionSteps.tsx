import { Check } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'
export function NativeChatQuestionSteps({
  questions,
  index,
  disabled,
  onSelect,
  answered
}: {
  questions: AskPrompt['questions']
  index: number
  disabled: boolean
  onSelect: (index: number) => void
  answered: readonly boolean[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const total = questions.length
  if (total <= 1) {
    return null
  }
  return (
    <div className="mb-2 flex shrink-0 gap-1 overflow-x-auto pb-1 scrollbar-sleek">
      {questions.map((qq, i) => (
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
