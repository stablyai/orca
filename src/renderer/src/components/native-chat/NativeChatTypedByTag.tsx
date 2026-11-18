import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import {
  otherPersonTypistWords,
  type OtherPersonTypist
} from '../../../../shared/agent-session/journal/agent-journal-typed-by'

/** "Sam Lee · Sam's MacBook Pro" over a message another person typed on their paired computer. */
export function NativeChatTypedByTag({ typist }: { typist: OtherPersonTypist }): React.JSX.Element {
  const t = useTranslate()
  const { name, computer, label } = otherPersonTypistWords(typist, t)
  return (
    <Badge variant="chatSender" title={label}>
      <span className="min-w-0 truncate font-medium text-chat-foreground">{name}</span>
      <span aria-hidden>·</span>
      <span className="min-w-0 truncate">{computer}</span>
    </Badge>
  )
}

/** The queued card's "From Sam Lee · Sam's MacBook Pro", worded like an agent's "From". */
export function NativeChatTypedByQueuedLine({
  typist
}: {
  typist: OtherPersonTypist
}): React.JSX.Element {
  const t = useTranslate()
  const { name, computer, label } = otherPersonTypistWords(typist, t)
  return (
    <div
      className="flex min-w-0 max-w-full items-center text-xs text-chat-foreground-faint"
      title={label}
    >
      <span className="shrink-0">
        {t('components.native-chat.queuedMessages.fromSender', 'From')}
      </span>
      <span className="min-w-0 truncate pr-1 pl-2">{name}</span>
      <span aria-hidden className="shrink-0 pr-1">
        ·
      </span>
      <span className="min-w-0 truncate">{computer}</span>
    </div>
  )
}
