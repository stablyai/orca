import { X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatQuestionText } from './NativeChatQuestionText'
import { NativeChatPromptCollapseToggle } from './NativeChatPromptCollapse'

/** The question card's question with its collapse and cancel controls. */
export function NativeChatQuestionCardHeader({
  question,
  isSubmitting,
  isCancelling,
  onCollapse,
  onCancel,
  renderQuestion
}: {
  question: string
  isSubmitting: boolean
  isCancelling: boolean
  onCollapse: (() => void) | undefined
  /** Without it (nothing to dismiss) there is no ×. */
  onCancel: (() => void) | undefined
  /** Draws the question's words in place of the plain heading (an item clamps a long ask). */
  renderQuestion?: (content: string) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-start gap-2 px-3.5 py-2.5">
      {renderQuestion ? (
        <div className="min-w-0 flex-1" data-testid="native-chat-question-card-title">
          {renderQuestion(question)}
        </div>
      ) : (
        <NativeChatQuestionText
          data-testid="native-chat-question-card-title"
          content={question}
          className="min-w-0 flex-1 break-words text-sm font-medium text-foreground [&_p]:my-0 [&_p+p]:mt-2"
        />
      )}
      {onCollapse ? (
        <NativeChatPromptCollapseToggle expanded disabled={isSubmitting} onToggle={onCollapse} />
      ) : null}
      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          disabled={isCancelling}
          aria-label={t('components.native-chat.question.cancel', 'Cancel')}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  )
}
