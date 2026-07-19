import { useEffect } from 'react'
import { registerWorkspaceSplitDropHighlight } from './workspace-split-drop-visual'

/** Fixed-position drop highlight for dragging a project from the sidebar into
 *  the workspace body. Hidden until the pointer drag reports a zone; reuses
 *  the tab-drop overlay styling so split affordances look identical. */
export default function WorkspaceSplitDropOverlay(): React.JSX.Element {
  useEffect(() => () => registerWorkspaceSplitDropHighlight(null), [])
  return (
    <div
      ref={registerWorkspaceSplitDropHighlight}
      className="tab-drop-overlay"
      style={{ position: 'fixed', display: 'none' }}
    />
  )
}
