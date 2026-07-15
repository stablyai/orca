import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { DiffLine } from './native-chat-diff'

/** Inline diff using the canonical git decoration tokens for both foreground
 * and tint, so light/dark themes share the same semantic palette. */
export function NativeChatDiffView({
  lines,
  truncated = false
}: {
  lines: DiffLine[]
  truncated?: boolean
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded bg-accent py-1 font-mono text-[11px] leading-relaxed">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            'whitespace-pre-wrap break-words px-2',
            line.kind === 'add' &&
              'bg-[color-mix(in_srgb,var(--git-decoration-added)_10%,transparent)] text-[var(--git-decoration-added)]',
            line.kind === 'del' &&
              'bg-[color-mix(in_srgb,var(--git-decoration-deleted)_10%,transparent)] text-[var(--git-decoration-deleted)]',
            line.kind === 'meta' && 'text-muted-foreground',
            line.kind === 'context' && 'text-foreground/70'
          )}
        >
          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          {line.text}
        </div>
      ))}
      {truncated ? (
        <div className="border-t border-border px-2 pt-1 text-muted-foreground">
          … {translate('components.native-chat.tool.diffTruncated', 'Diff truncated')}
        </div>
      ) : null}
    </div>
  )
}
