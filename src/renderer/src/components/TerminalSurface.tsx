import EditorAutosaveController from './editor/EditorAutosaveController'
import { useAnyBrowserGuestNeedsPaint } from './browser-pane/host-guest/browser-guest-paint-retention'
import { TerminalTitlebarTabs } from './TerminalTitlebarTabs'
import { TerminalSplitWorkspaceSurfaces } from './TerminalSplitWorkspaceSurfaces'
import { TerminalLegacyWorkspaceSurface } from './TerminalLegacyWorkspaceSurface'
import { TerminalWorkspaceDialogs } from './TerminalWorkspaceDialogs'
import type { TerminalController } from './use-terminal-controller'

export function TerminalSurface({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element {
  const { renderedActiveWorktreeId } = controller
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(!renderedActiveWorktreeId)
  return (
    <div
      // The workbench already removes hidden content from flow; only keep this ancestor paintable.
      className={`flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden${
        renderedActiveWorktreeId
          ? ''
          : retainBrowserGuestPaint
            ? ' opacity-0 pointer-events-none'
            : ' hidden'
      }`}
      data-rendered-active-worktree-id={renderedActiveWorktreeId ?? undefined}
    >
      <EditorAutosaveController />
      <TerminalTitlebarTabs controller={controller} />
      <TerminalSplitWorkspaceSurfaces controller={controller} />
      <TerminalLegacyWorkspaceSurface controller={controller} />
      <TerminalWorkspaceDialogs controller={controller} />
    </div>
  )
}
