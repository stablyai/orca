import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { useMaestroWorkspaceViewport } from './useMaestroWorkspaceViewport'

type ToolbarProps = {
  board: ReturnType<typeof useMaestroWorkspaceViewport>
}

export function MaestroWorkspaceToolbar({ board }: ToolbarProps) {
  return (
    <div className="absolute right-3 top-3 z-40 flex items-center gap-1 rounded-lg border border-border/80 bg-card/90 p-1 shadow-xs backdrop-blur-md">
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={() => board.zoom(0.85)}
        aria-label={translate(
          'auto.components.maestro.MaestroWorkspaceCanvas.5d7ccb0d24',
          'Zoom out'
        )}
      >
        <ZoomOut />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={() => board.zoom(1.15)}
        aria-label={translate(
          'auto.components.maestro.MaestroWorkspaceCanvas.954805c1ea',
          'Zoom in'
        )}
      >
        <ZoomIn />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={board.fit}
        aria-label={translate(
          'auto.components.maestro.MaestroWorkspaceCanvas.4a1926ece1',
          'Fit resources'
        )}
      >
        <Maximize2 />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        onClick={board.reset}
        aria-label={translate(
          'auto.components.maestro.MaestroWorkspaceCanvas.0299b5276f',
          'Reset viewport'
        )}
      >
        <RotateCcw />
      </Button>
    </div>
  )
}
