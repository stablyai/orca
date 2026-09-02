import React from 'react'
import { TerminalSurface } from './TerminalSurface'
import { useTerminalController } from './use-terminal-controller'

function Terminal(): React.JSX.Element | null {
  return <TerminalSurface controller={useTerminalController()} />
}

export default React.memo(Terminal)
