import type { RefObject } from 'react'
import { cn } from '@/lib/utils'
import { PreviewPhaseOverlay, type PreviewPhase } from './preview-terminal-phase-overlay'

export function PreviewTerminalSurface({
  containerRef,
  className,
  background,
  phase,
  ptyId,
  ptyGone,
  hasWorkspace
}: {
  containerRef: RefObject<HTMLDivElement | null>
  className?: string
  background?: string
  phase: PreviewPhase
  ptyId: string
  ptyGone: boolean
  hasWorkspace: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'relative h-[calc(100vh-140px)] w-full overflow-hidden bg-background p-1.5',
        className
      )}
      style={background ? { backgroundColor: background } : undefined}
    >
      <PreviewPhaseOverlay phase={phase} ptyId={ptyId} ptyGone={ptyGone} background={background} />
      <div
        aria-hidden={ptyGone || undefined}
        data-native-file-drop-target={hasWorkspace ? 'rejected' : undefined}
        className={cn('flex h-full w-full items-end overflow-hidden', ptyGone && 'invisible')}
      >
        <div ref={containerRef} className="origin-bottom-left" />
      </div>
    </div>
  )
}
