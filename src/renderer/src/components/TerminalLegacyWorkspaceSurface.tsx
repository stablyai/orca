import { TerminalLegacyTerminalPanes } from './TerminalLegacyTerminalPanes'
import { TerminalLegacyBrowserPanes } from './TerminalLegacyBrowserPanes'
import { TerminalLegacyEditorSurface } from './TerminalLegacyEditorSurface'
import type { TerminalController } from './use-terminal-controller'
import { useAppStore } from '@/store'

export function TerminalLegacyWorkspaceSurface({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const hasWindowPanes = useAppStore((state) => Boolean(state.windowPaneLayout))
  if (
    hasWindowPanes ||
    controller.effectiveActiveLayout ||
    controller.anyMountedWorktreeHasLayout
  ) {
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
