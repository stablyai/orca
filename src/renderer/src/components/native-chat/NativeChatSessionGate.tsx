import type * as React from 'react'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import {
  resolveNativeChatSession,
  type NativeChatPaneResolution,
  type NativeChatPaneResolutionInput
} from './native-chat-pane-resolution'

export type NativeChatSessionGateProps = NativeChatPaneResolutionInput & {
  children: (resolution: NativeChatPaneResolution) => React.ReactNode
}

/** Keeps NativeChatView's agent/session resolution separate from the heavy
 *  conversation surface so unsupported panes fail before transcript IO starts. */
export function NativeChatSessionGate({
  children,
  ...input
}: NativeChatSessionGateProps): React.JSX.Element {
  const resolution = resolveNativeChatSession(input)
  if (!resolution) {
    return <NativeChatEmptyState kind="not-agent" />
  }
  return <>{children(resolution)}</>
}
