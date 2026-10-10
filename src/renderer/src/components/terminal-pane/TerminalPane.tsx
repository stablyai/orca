import { TerminalPaneSurface } from './TerminalPaneSurface'
import { useTerminalPaneController } from './use-terminal-pane-controller'
import type { TerminalPaneProps } from './terminal-pane-types'

export default function TerminalPane(props: TerminalPaneProps): React.JSX.Element {
  return <TerminalPaneSurface controller={useTerminalPaneController(props)} />
}
