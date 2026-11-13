import { cn } from '../../../../lib/class-names'
import { useTranslate } from '../../../../i18n/use-translate'
import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatProviderFrameSummary } from '../../../../../../shared/native-chat/native-chat-provider-frame-summary'

export function ProviderFrameRow({
  block,
  summary,
  detail
}: {
  block: NativeChatBlock
  summary?: string
  detail?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  if (block.type !== 'text' || (!block.providerFrame && !detail)) {
    return null
  }
  const frame = block.providerFrame
  return (
    <NativeChatDetailsDisclosure
      lead={
        frame ? (
          <span className="font-medium text-chat-foreground-strong">{frame.provider}</span>
        ) : null
      }
      summary={summary ?? nativeChatProviderFrameSummary(block)}
      trail={
        frame?.payload.truncated ? (
          <span>
            ·{' '}
            {t('components.native-chat.providerFrame.byteCount', '{{count}} bytes', {
              count: frame.payload.byteLength,
              defaultValue_one: '{{count}} byte'
            })}
          </span>
        ) : null
      }
    >
      {detail}
      {detail && frame ? '\n\n' : ''}
      {frame?.payload.head}
      {frame?.payload.truncated ? '\n…' : ''}
    </NativeChatDetailsDisclosure>
  )
}

/** A collapsed monospace body, for provider frames and the diagnostics behind a failure. */
export function NativeChatDetailsDisclosure({
  summary,
  lead,
  trail,
  className,
  summaryClassName,
  bodyClassName,
  bodyAs = 'pre',
  open,
  onOpenChange,
  children
}: {
  summary: string
  lead?: React.ReactNode
  trail?: React.ReactNode
  className?: string
  summaryClassName?: string
  bodyClassName?: string
  bodyAs?: 'pre' | 'div'
  /** Given with `onOpenChange` when the reader's choice is kept outside the row. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}): React.JSX.Element {
  const Body = bodyAs
  return (
    <details
      className={cn('group text-xs text-chat-foreground-faint', className)}
      open={open}
      onToggle={(event) => {
        // Mounting already open also fires; only a reader's toggle is a choice.
        if (event.currentTarget.open !== open) {
          onOpenChange?.(event.currentTarget.open)
        }
      }}
    >
      <summary
        aria-expanded={open}
        title={summary}
        className={cn(
          'flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          summaryClassName
        )}
      >
        <span className="transition-transform motion-reduce:transition-none group-open:rotate-90">
          ›
        </span>
        {lead}
        <span className="min-w-0 truncate">{summary}</span>
        {trail}
      </summary>
      <Body
        data-native-chat-code-content
        className={cn(
          'scrollbar-sleek mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 font-mono text-chat-code text-foreground',
          bodyClassName
        )}
      >
        {children}
      </Body>
    </details>
  )
}
