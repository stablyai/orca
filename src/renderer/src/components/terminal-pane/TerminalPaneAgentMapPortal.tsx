import { createPortal } from 'react-dom'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { AgentSessionMapView } from '../agent-session-map/AgentSessionMapView'
import { AgentMapPaneCover } from './AgentMapPaneCover'
import type { TerminalPaneController } from './controller/use-terminal-pane-controller'

/**
 * The live agent-map cover for a pane in `map` view mode. Like the chat cover it overlays
 * the (still-mounted) terminal so the session keeps running underneath; it targets the
 * active pane, so the map shows the agent session the user was looking at when they
 * switched. `activePane` is the pane the user toggled from, which owns the session.
 */
export function TerminalPaneAgentMapPortal({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const { activePane, effectiveMapViewMode, isActive, isRendererVisible, tabId } = controller
  if (!effectiveMapViewMode || !activePane?.container) {
    return null
  }
  const paneKey = makePaneKey(tabId, activePane.leafId)
  return createPortal(
    <AgentMapPaneCover pane={activePane}>
      <AgentSessionMapView
        tabId={tabId}
        paneKey={paneKey}
        isVisible={isActive && isRendererVisible}
      />
    </AgentMapPaneCover>,
    activePane.container,
    `agent-map-${tabId}-${activePane.leafId}`
  )
}
