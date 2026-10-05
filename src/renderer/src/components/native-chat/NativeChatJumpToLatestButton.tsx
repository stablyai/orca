import { ArrowDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function NativeChatJumpToLatestButton({
  onClick
}: {
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={translate('components.native-chat.jumpToLatest', 'Jump to latest')}
      className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowDown className="size-3.5" />
      <span>{translate('components.native-chat.jumpToLatest', 'Jump to latest')}</span>
    </button>
  )
}
