import { cn } from '@/lib/utils'
import type { DiffLine } from './native-chat-diff'

/** Inline coloured diff, used for Edit/Write tool calls and diff-style tool
 *  results. Adds/dels use the git-decoration tokens with a faint tinted ground,
 *  matching the terminal's diff palette (no invented colors). */
export function NativeChatDiffView({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded bg-accent py-1 font-mono text-[11px] leading-relaxed">
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap break-words px-2',
            line.kind === 'add' && 'bg-emerald-500/10 text-[var(--git-decoration-added)]',
            line.kind === 'del' && 'bg-rose-500/10 text-[var(--git-decoration-deleted)]',
            line.kind === 'meta' && 'text-muted-foreground',
            line.kind === 'context' && 'text-foreground/70'
          )}
        >
          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          {line.text}
        </div>
      ))}
    </div>
  )
}
