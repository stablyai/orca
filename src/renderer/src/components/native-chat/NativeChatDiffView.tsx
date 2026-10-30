import { cn } from '@/lib/utils'
import type { NativeChatDiffLine as DiffLine } from '../../../../shared/native-chat/tools/native-chat-diff'

export function NativeChatDiffView({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <div
      data-native-chat-code-content
      className="overflow-hidden rounded-lg border border-chat-code-border bg-chat-code-surface py-1 font-mono text-chat-code leading-relaxed text-chat-foreground"
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre-wrap break-words px-2',
            line.kind === 'add' && 'bg-[var(--diff-added-ground)] text-chat-diff-added',
            line.kind === 'del' && 'bg-[var(--diff-removed-ground)] text-chat-diff-removed',
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
