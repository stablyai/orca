import { forwardRef } from 'react'
import { TerminalPaneSurface } from './TerminalPaneSurface'
import { useTerminalPaneController } from './use-terminal-pane-controller'
import type { TerminalPaneHandle, TerminalPaneProps } from './terminal-pane-types'

export type { TerminalPaneHandle } from './terminal-pane-types'

function TerminalPane(
  props: TerminalPaneProps,
  ref: React.ForwardedRef<TerminalPaneHandle>
): React.JSX.Element {
  return <TerminalPaneSurface controller={useTerminalPaneController(props, ref)} />
}

export default forwardRef(TerminalPane)
