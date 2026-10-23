import { memo } from 'react'
import LiveSurfacePaneOverlayLayer from '../tab-group/LiveSurfacePaneOverlayLayer'
import DesktopAppPane from './DesktopAppPane'

const DesktopAppPaneOverlayLayer = memo(function DesktopAppPaneOverlayLayer({
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
      contentType="desktop-app"
      renderPane={(tab, isActive) => <DesktopAppPane tab={tab} isActive={isActive} />}
    />
  )
})

export default DesktopAppPaneOverlayLayer
