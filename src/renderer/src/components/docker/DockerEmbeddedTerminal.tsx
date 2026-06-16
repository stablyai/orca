import React from 'react'
import { useEmbeddedPtyTerminal } from './use-embedded-pty-terminal'

/**
 * An xterm pane bound to a docker PTY (logs or exec). The parent remounts this
 * via a React key when the command/container changes, which kills the old PTY.
 *
 * Pass `readOnly` for display-only streams (e.g. docker logs) where keyboard
 * input must not be forwarded to the PTY.
 */
export function DockerEmbeddedTerminal({
  command,
  connectionId,
  readOnly
}: {
  command: string
  connectionId: string | null
  readOnly?: boolean
}): React.JSX.Element {
  const { containerRef } = useEmbeddedPtyTerminal({ command, connectionId, readOnly })
  return <div ref={containerRef} className="xterm-container h-full w-full" />
}
