import type React from 'react'
import { createPortal } from 'react-dom'
import { useZotzBackgroundPanelTarget } from './zotz-background-panel-target'
import {
  ZotzBackgroundTaskOutputsContext,
  type ZotzBackgroundTaskOutputs
} from './zotz-background-task-outputs'

/** Shows a chat's background-tasks strip in the right sidebar's Background panel, never above the chat. */
export function ZotzBackgroundTasksPortal({
  active,
  outputs = null,
  children
}: {
  /** Only the visible, focused chat pane fills the panel. */
  active: boolean
  /** Lets shell rows expand to their output here; the strip elsewhere is unchanged. */
  outputs?: ZotzBackgroundTaskOutputs | null
  children: React.ReactNode
}): React.JSX.Element | null {
  const target = useZotzBackgroundPanelTarget()
  if (!active || !target) {
    return null
  }
  return createPortal(
    <ZotzBackgroundTaskOutputsContext.Provider value={outputs}>
      {children}
    </ZotzBackgroundTaskOutputsContext.Provider>,
    target
  )
}
