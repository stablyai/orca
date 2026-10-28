import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import {
  resolveNativeChatSession,
  type NativeChatPaneResolution,
  type NativeChatPaneResolutionInput
} from './native-chat-pane-resolution'

export type NativeChatSessionGateProps = NativeChatPaneResolutionInput & {
  children: (resolution: NativeChatPaneResolution) => ReactNode
}

/** Keeps NativeChatView's agent/session resolution separate from the heavy
 *  conversation surface so unsupported panes fail before transcript IO starts. */
export function NativeChatSessionGate({
  children,
  ...input
}: NativeChatSessionGateProps): JSX.Element {
  const lastResolutionRef = useRef<NativeChatPaneResolution | null>(null)
  const currentResolution = resolveNativeChatSession(input)
  const previousResolution =
    lastResolutionRef.current?.paneKey === input.paneKey ? lastResolutionRef.current : null
  const resolution = (() => {
    if (!currentResolution) {
      return previousResolution
    }
    if (
      previousResolution?.agent === currentResolution.agent &&
      previousResolution.sessionId &&
      !currentResolution.sessionId
    ) {
      // Preserve session identity through partial reconnect snapshots so transcript IO and the composer do not reset.
      return {
        ...currentResolution,
        sessionId: previousResolution.sessionId,
        transcriptPath: previousResolution.transcriptPath
      }
    }
    return currentResolution
  })()
  useEffect(() => {
    if (resolution) {
      // Retain the rendered identity because hook/title evidence can disappear before transport replay.
      lastResolutionRef.current = resolution
    }
  }, [resolution])
  if (!resolution) {
    return <NativeChatEmptyState kind="not-agent" />
  }
  return <>{children(resolution)}</>
}
