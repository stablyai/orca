import { TerminalPaneSurface } from './controller/TerminalPaneSurface'
import { useTerminalPaneController } from './controller/use-terminal-pane-controller'
import type { TerminalPaneProps } from './controller/terminal-pane-types'

export default function TerminalPane(props: TerminalPaneProps): React.JSX.Element {
  return <TerminalPaneSurface controller={useTerminalPaneController(props)} />
}
