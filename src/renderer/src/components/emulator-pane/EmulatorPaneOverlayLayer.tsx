import { memo } from 'react'
import LiveSurfacePaneOverlayLayer from '../tab-group/LiveSurfacePaneOverlayLayer'
import EmulatorPane from './EmulatorPane'

const EmulatorPaneOverlayLayer = memo(function EmulatorPaneOverlayLayer({
  worktreeId,
  isWorktreeActive
}: {
  worktreeId: string
  isWorktreeActive: boolean
}): React.JSX.Element {
  return (
    <LiveSurfacePaneOverlayLayer
      worktreeId={worktreeId}
      isWorktreeActive={isWorktreeActive}
      contentType="simulator"
      renderPane={(tab, isActive) => (
        <EmulatorPane tab={tab} worktreeId={tab.worktreeId} isActive={isActive} />
      )}
    />
  )
})

export default EmulatorPaneOverlayLayer
