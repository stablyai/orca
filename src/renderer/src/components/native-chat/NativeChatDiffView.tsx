import { cn } from '@/lib/utils'
import type { DiffLine } from './native-chat-diff'

/** Inline coloured diff, used for Edit/Write tool calls and diff-style tool
 *  results. Adds/dels use the git-decoration tokens with a faint tinted ground,
 *  matching the terminal's diff palette (no invented colors). */
export function NativeChatDiffView({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <div
      data-native-chat-code-content
      className="overflow-hidden rounded-lg border border-chat-code-border bg-chat-code-surface py-1 font-mono text-xs leading-relaxed text-chat-foreground"
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap break-words px-2',
            line.kind === 'add' &&
              'bg-[var(--diff-added-ground)] text-[var(--git-decoration-added)]',
            line.kind === 'del' &&
              'bg-[var(--diff-removed-ground)] text-[var(--git-decoration-deleted)]',
            line.kind === 'meta' && 'text-chat-foreground-faint',
            line.kind === 'context' && 'text-chat-foreground'
          )}
        >
          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          {line.text}
        </div>
      ))}
    </div>
  )
}
