import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import { cn } from '@/lib/class-names'
import type { WorkerDockGlyph as Glyph } from './worker-dock-card-order'

/** One 12px status mark: amber question, red dot, yellow spinner, grey ring or green dot. The row's
 *  label carries the state for assistive technology, so the mark itself is decorative. */
export function WorkerDockGlyph({ glyph }: { glyph: Glyph }) {
  return (
    <span
      aria-hidden="true"
      data-worker-dock-glyph={glyph}
      className="inline-flex size-3 shrink-0 items-center justify-center"
    >
      {glyph === 'ask' ? (
        <AgentQuestionIcon className="size-3" />
      ) : glyph === 'running' ? (
        <AgentWorkingSpinner className="size-2.5" />
      ) : (
        <span
          className={cn(
            'block size-2 rounded-full',
            glyph === 'failed' && 'bg-destructive',
            glyph === 'done' && 'bg-status-success',
            glyph === 'queued' && 'border-[1.5px] border-muted-foreground'
          )}
        />
      )}
    </span>
  )
}
