import type { RefObject } from 'react'
import { History } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export function PreviewTerminalShell({
  containerRef,
  ptyGone,
  historical,
  backgroundColor,
  className
}: {
  containerRef: RefObject<HTMLDivElement | null>
  ptyGone: boolean
  historical: boolean
  backgroundColor?: string
  className?: string
}): React.JSX.Element {
  return (
    // Why: a size fixed by the viewport keeps the dialog stable regardless of
    // the serialized buffer. The terminal retains its real dimensions and the
    // controller scales or clips it while keeping the cursor end visible.
    <div
      className={cn(
        'relative flex h-[calc(100vh-140px)] w-full flex-col gap-1.5 overflow-hidden bg-background p-1.5',
        className
      )}
      style={backgroundColor ? { backgroundColor } : undefined}
    >
      {ptyGone ? (
        <div className="absolute inset-0 flex items-center justify-center px-2.5 py-8 text-center text-[11px] text-muted-foreground">
          {translate(
            'dashboardPopout.terminal.closed',
            "No live terminal — this agent's pane has closed."
          )}
        </div>
      ) : null}
      {historical ? (
        <div
          role="status"
          className="flex shrink-0 items-start gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-1 text-[11px] text-amber-700 dark:text-amber-300"
        >
          <History className="mt-px size-3 shrink-0" aria-hidden />
          <span>
            {translate(
              'dashboardPopout.terminal.historical',
              "Showing this pane's last saved frame — it isn't attached right now. Open the worktree to resume it."
            )}
          </span>
        </div>
      ) : null}
      <div
        aria-hidden={ptyGone || undefined}
        className={cn(
          'flex min-h-0 w-full flex-1 items-end overflow-hidden',
          ptyGone && 'invisible'
        )}
      >
        <div ref={containerRef} className="origin-bottom-left" />
      </div>
    </div>
  )
}
