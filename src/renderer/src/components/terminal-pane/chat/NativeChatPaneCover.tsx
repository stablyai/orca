import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { isEditableTarget } from '@/lib/text-input/focus/editable-target'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { useCoveredTerminalFocusHandoff } from './use-covered-terminal-focus-handoff'
import { requestNativeChatCoverPaste } from '../input/paste/native-chat-cover-paste'
import { restoreWebglAfterChatCover } from '@/lib/pane-manager/terminal-rendering/pane-webgl-reattach'

/** The cover owns focus and paste for its pane until a chat input can take them. */
export function NativeChatPaneCover({
  pane,
  children
}: {
  pane: Pick<ManagedPane, 'container' | 'terminal'>
  children: ReactNode
}): React.JSX.Element {
  const coverRef = useRef<HTMLDivElement>(null)
  useCoveredTerminalFocusHandoff(coverRef, pane.terminal)
  // An atlas rebuild leaves covered panes detached; reattach once the terminal shows again.
  useLayoutEffect(() => () => restoreWebglAfterChatCover(pane.terminal), [pane.terminal])
  return (
    <div
      ref={coverRef}
      tabIndex={-1}
      className="native-chat-pane-shell absolute inset-0 z-10 flex min-h-0 min-w-0 bg-chat-canvas focus:outline-none"
      onPaste={(event) => {
        // Chat inputs claim their pastes first; one that reaches here found no chat input.
        if (event.defaultPrevented || isEditableTarget(event.target)) {
          return
        }
        event.preventDefault()
        requestNativeChatCoverPaste(pane)
      }}
    >
      {children}
    </div>
  )
}
