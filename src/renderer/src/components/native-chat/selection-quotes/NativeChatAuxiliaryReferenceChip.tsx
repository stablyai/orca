import { Quote, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

/** One selected-text chip, shared by the pending composer strip and sent user rows. */
export function NativeChatAuxiliaryReferenceChip({
  text,
  onRemove
}: {
  text: string
  onRemove?: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex max-w-80 min-w-0 items-start gap-1 rounded-lg border border-border bg-chat-canvas py-1 pr-1 pl-2 text-xs text-chat-foreground select-none"
      data-native-chat-auxiliary-reference=""
    >
      <Quote aria-hidden className="mt-0.5 size-3.5 shrink-0 text-chat-foreground-faint" />
      <span title={text} className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words">
        {text}
      </span>
      {onRemove ? <RemoveReferenceButton onRemove={onRemove} /> : null}
    </div>
  )
}

function RemoveReferenceButton({ onRemove }: { onRemove: () => void }): React.JSX.Element {
  const t = useTranslate()
  const label = t('components.native-chat.composer.removeSelection', 'Remove selection')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onRemove}
    >
      <X className="size-3" />
    </button>
  )
}
