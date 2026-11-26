import type { CSSProperties } from 'react'
import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/agent/status/AgentWorkingSpinner'
import { handleDotWaveAnimationStart } from '@/components/ui/shared-animation-clock'
import { cn } from '@/lib/class-names'
import { observeOffscreenAnimation } from '@/lib/window-activity/offscreen-animation-pause'
import type { WorkerDockGlyph as Glyph } from './worker-dock-card-order'

// A 3×3 wave lit along diagonals, top-left first: each diagonal (row + column, 0..4) starts 2s/7.5
// later. Built once, so a re-render allocates nothing.
const DOT_GRID_CELLS: readonly CSSProperties[] = Array.from({ length: 9 }, (_, index) => ({
  animationDelay: `${((2000 * (Math.floor(index / 3) + (index % 3))) / 7.5).toFixed(1)}ms`
}))

/** The chip's running mark: a small dot grid whose opacity wave runs on the compositor (main.css),
 *  stops offscreen and holds still under reduced motion. */
function WorkerDockDotGrid() {
  return (
    <span
      ref={observeOffscreenAnimation}
      onAnimationStart={handleDotWaveAnimationStart}
      data-worker-dock-dot-grid=""
      className="worker-dock-dot-grid grid grid-cols-[repeat(3,2px)] gap-px"
    >
      {DOT_GRID_CELLS.map((style, index) => (
        <span key={index} style={style} className="block size-0.5 rounded-[1px] bg-agent-working" />
      ))}
    </span>
  )
}

/** One 12px status mark: amber question, red dot, yellow spinner, grey ring or green dot. The row's
 *  label carries the state for assistive technology, so the mark itself is decorative. `still`
 *  draws running as a quiet dot grid instead of the spinner, for the always-visible chip. */
export function WorkerDockGlyph({ glyph, still = false }: { glyph: Glyph; still?: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-worker-dock-glyph={glyph}
      className="inline-flex size-3 shrink-0 items-center justify-center"
    >
      {glyph === 'ask' ? (
        <AgentQuestionIcon className="size-3" />
      ) : glyph === 'running' && still ? (
        <WorkerDockDotGrid />
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
