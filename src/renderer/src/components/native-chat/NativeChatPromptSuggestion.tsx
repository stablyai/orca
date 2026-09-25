import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'

export function NativeChatPromptSuggestion({
  text,
  onAccept
}: {
  text: string
  onAccept?: () => void
}): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-x-2 top-1 flex items-start gap-2">
      <span
        role="status"
        className="min-w-0 flex-1 line-clamp-2 break-words text-sm text-muted-foreground/60"
      >
        {text}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="pointer-events-auto"
        aria-label={translate(
          'components.native-chat.composer.acceptPromptSuggestion',
          'Use suggested prompt'
        )}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onAccept}
      >
        <ShortcutKeyCombo keys={['Tab']} />
      </Button>
    </div>
  )
}
