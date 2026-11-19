import type React from 'react'
import { createPortal } from 'react-dom'
import { useZotzBackgroundPanelTarget } from './zotz-background-panel-target'

/** Shows a chat's background-tasks strip in the right sidebar's Background panel, never above the chat. */
export function ZotzBackgroundTasksPortal({
  active,
  children
}: {
  /** Only the visible, focused chat pane fills the panel. */
  active: boolean
  children: React.ReactNode
}): React.JSX.Element | null {
  const target = useZotzBackgroundPanelTarget()
  return active && target ? createPortal(children, target) : null
}
