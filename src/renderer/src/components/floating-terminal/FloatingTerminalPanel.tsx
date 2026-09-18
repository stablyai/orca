import { createPortal } from 'react-dom'
import { PopoutPortalContainerContext } from '@/components/ui/portal-container-context'
import { useRadixBodyPointerEventsRecovery } from '@/hooks/useRadixBodyPointerEventsRecovery'
import { renderFloatingTerminalPanelSurface } from './FloatingTerminalPanelSurface'
import type { FloatingTerminalPanelProps } from './floating-terminal-panel-types'
import { useFloatingTerminalPanelController } from './use-floating-terminal-panel-controller'

export { FloatingTerminalToggleButton } from './FloatingTerminalToggleButton'
export { clearReportedFloatingFocusCache } from './floating-terminal-focus-reporting'

export function FloatingTerminalPanel(props: FloatingTerminalPanelProps): React.JSX.Element | null {
  const surface = useFloatingTerminalPanelController(props)
  useRadixBodyPointerEventsRecovery(surface.portalContainer?.ownerDocument)
  if (surface.isDetached) {
    if (!surface.portalContainer) {
      return null
    }
    return createPortal(
      <PopoutPortalContainerContext.Provider value={surface.portalContainer}>
        {renderFloatingTerminalPanelSurface(surface)}
      </PopoutPortalContainerContext.Provider>,
      surface.portalContainer
    )
  }
  return renderFloatingTerminalPanelSurface(surface)
}
