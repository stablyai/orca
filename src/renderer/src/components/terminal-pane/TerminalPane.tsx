import { LoneTerminalPaneWidthHandles } from './LoneTerminalPaneWidthHandles'
import { TerminalPaneSurface } from './TerminalPaneSurface'
import { TerminalRestoringPlaceholder } from './TerminalRestoringPlaceholder'
import { useTerminalPaneController } from './use-terminal-pane-controller'
import { useHostTerminalScrollbackHold } from './use-host-terminal-scrollback-hold'
import type { TerminalPaneProps } from './terminal-pane-types'

function MountedTerminalPane(props: TerminalPaneProps): React.JSX.Element {
  const controller = useTerminalPaneController(props)
  return (
    <>
      <TerminalPaneSurface controller={controller} />
      <LoneTerminalPaneWidthHandles controller={controller} />
    </>
  )
}

export default function TerminalPane(props: TerminalPaneProps): React.JSX.Element {
  const holdForHostScrollback = useHostTerminalScrollbackHold(props.tabId, props.worktreeId)
  return holdForHostScrollback ? (
    <TerminalRestoringPlaceholder />
  ) : (
    <MountedTerminalPane {...props} />
  )
}
