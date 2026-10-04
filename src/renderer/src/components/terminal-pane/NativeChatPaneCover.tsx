import { useRef, type ReactNode } from 'react'
import { isEditableTarget } from '@/lib/editable-target'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { useCoveredTerminalFocusHandoff } from './use-covered-terminal-focus-handoff'
import { requestNativeChatCoverPaste } from './native-chat-cover-paste'

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
  return (
    <div
      ref={coverRef}
      tabIndex={-1}
      className="native-chat-pane-shell absolute inset-0 z-10 flex min-h-0 min-w-0 bg-background focus:outline-none"
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
