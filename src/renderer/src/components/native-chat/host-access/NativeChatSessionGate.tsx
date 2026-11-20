import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import {
  resolveNativeChatSession,
  type NativeChatPaneResolution,
  type NativeChatPaneResolutionInput
} from '../pane/routing/native-chat-pane-resolution'

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
  const resolution = resolveNativeChatSession(input, lastResolutionRef.current)
  useEffect(() => {
    lastResolutionRef.current = resolution
  }, [resolution])
  if (!resolution) {
    // Why its own canvas: over a theme image the cover is clear and only a chat root paints.
    return (
      <div className="flex size-full bg-chat-canvas">
        <NativeChatEmptyState kind="not-agent" />
      </div>
    )
  }
  return <>{children(resolution)}</>
}
