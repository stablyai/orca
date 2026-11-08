import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { NativeChatQuestionText } from './NativeChatQuestionText'
import { NativeChatPromptCollapseToggle } from './NativeChatPromptCollapse'
export function NativeChatQuestionHeader({
  question,
  heading,
  context,
  disabled,
  isCancelling,
  onCancel,
  onCollapse
}: {
  question: string
  heading?: string
  context?: ReactNode
  disabled: boolean
  isCancelling: boolean
  onCancel?: () => void
  onCollapse?: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="flex items-start gap-2 px-3.5 py-2.5">
        {heading ? (
          <p className="min-w-0 flex-1 text-sm font-semibold text-foreground">{heading}</p>
        ) : (
          <NativeChatQuestionText
            data-testid="native-chat-question-card-title"
            content={question}
            className="min-w-0 flex-1 break-words text-sm font-semibold text-foreground [&_p]:my-0 [&_p+p]:mt-2"
          />
        )}
        {onCollapse ? (
          <NativeChatPromptCollapseToggle expanded disabled={disabled} onToggle={onCollapse} />
        ) : null}
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={isCancelling}
            aria-label={translate('components.native-chat.question.cancel', 'Cancel')}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {context ? (
        <div className="space-y-2 px-3.5 pb-2.5 text-xs text-muted-foreground">{context}</div>
      ) : null}
      {heading ? (
        <NativeChatQuestionText
          content={question}
          className="break-words px-3.5 pb-2.5 text-sm text-foreground [&_p]:my-0 [&_p+p]:mt-2 [overflow-wrap:anywhere]"
        />
      ) : null}
    </>
  )
}
