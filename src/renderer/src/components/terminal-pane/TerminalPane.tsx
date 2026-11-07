import { TerminalPaneSurface } from './TerminalPaneSurface'
import { TerminalRestoringPlaceholder } from './TerminalRestoringPlaceholder'
import { useTerminalPaneController } from './controller/use-terminal-pane-controller'
import { useHostTerminalScrollbackHold } from './snapshots/use-host-terminal-scrollback-hold'
import type { TerminalPaneProps } from './controller/terminal-pane-types'

function MountedTerminalPane(props: TerminalPaneProps): React.JSX.Element {
  return <TerminalPaneSurface controller={useTerminalPaneController(props)} />
}

export default function TerminalPane(props: TerminalPaneProps): React.JSX.Element {
  const holdForHostScrollback = useHostTerminalScrollbackHold(props.tabId, props.worktreeId)
  return holdForHostScrollback ? (
    <TerminalRestoringPlaceholder />
  ) : (
    <MountedTerminalPane {...props} />
  )
}
