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
  bodyClassName,
  children
}: {
  summary: string
  lead?: React.ReactNode
  trail?: React.ReactNode
  bodyClassName?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <details className="group text-xs text-chat-foreground-faint">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="transition-transform motion-reduce:transition-none group-open:rotate-90">
          ›
        </span>
        {lead}
        <span className="min-w-0 truncate">{summary}</span>
        {trail}
      </summary>
      <pre
        data-native-chat-code-content
        className={cn(
          'scrollbar-sleek mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 font-mono text-chat-code text-foreground',
          bodyClassName
        )}
      >
        {children}
      </pre>
    </details>
  )
}
