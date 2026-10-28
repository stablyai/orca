import { TerminalLegacyTerminalPanes } from './TerminalLegacyTerminalPanes'
import { TerminalLegacyBrowserPanes } from './TerminalLegacyBrowserPanes'
import { TerminalLegacyEditorSurface } from './TerminalLegacyEditorSurface'
import type { TerminalController } from './use-terminal-controller'
import { useAppStore } from '@/store'
import { selectShownWorkspaceView } from '@/lib/workspace-view-catalog'

export function TerminalLegacyWorkspaceSurface({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const workspaceView = useAppStore(selectShownWorkspaceView)
  if (workspaceView || controller.effectiveActiveLayout || controller.anyMountedWorktreeHasLayout) {
    return null
  }
  return (
    <>
      <TerminalLegacyTerminalPanes controller={controller} />
      <TerminalLegacyBrowserPanes controller={controller} />
      <TerminalLegacyEditorSurface controller={controller} />
    </>
  )
}
