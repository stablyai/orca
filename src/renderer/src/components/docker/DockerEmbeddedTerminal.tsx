import React from 'react'
import { useEmbeddedPtyTerminal } from './use-embedded-pty-terminal'

/**
 * An xterm pane bound to a docker PTY (logs or exec). The parent remounts this
 * via a React key when the command/container changes, which kills the old PTY.
 */
export function DockerEmbeddedTerminal({
  command,
  connectionId
}: {
  command: string
  connectionId: string | null
}): React.JSX.Element {
  const { containerRef } = useEmbeddedPtyTerminal({ command, connectionId })
  return <div ref={containerRef} className="xterm-container h-full w-full" />
}
