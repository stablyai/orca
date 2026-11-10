import { ArrowUp } from 'lucide-react'
import { cn } from '../../../../lib/class-names'
import { useTranslate } from '../../../../i18n/use-translate'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { NativeChatMessageTimestamp } from '../rows/NativeChatMessageTimestamp'
import { withoutNativeChatVisualDirectiveLines } from '../../../../../../shared/native-chat/native-chat-visual-directive'

export function NativeChatAgentControls({
  markdown,
  timestamp,
  onScrollToTop,
  action,
  className
}: {
  markdown: string
  timestamp: number | null
  onScrollToTop: () => void
  /** A row action of its own, drawn beside Copy (Fork). */
  action?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    // Row chrome, not transcript: find skips it.
    <div data-native-chat-find-skip className={cn('flex items-center gap-1', className)}>
      {/* A visual line means nothing pasted outside Orca, so the copy leaves it out. An image-only
          response has nothing to copy, so it has no Copy. */}
      {markdown.length > 0 ? (
        <NativeChatCopyButton text={withoutNativeChatVisualDirectiveLines(markdown)} />
      ) : null}
      {action}
      <button
        type="button"
        onClick={onScrollToTop}
        aria-label={t('components.native-chat.scrollMessageToTop', 'Scroll this message to top')}
        title={t('components.native-chat.scrollMessageToTop', 'Scroll this message to top')}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowUp className="size-3.5" />
      </button>
      <NativeChatMessageTimestamp timestamp={timestamp} />
    </div>
  )
}
