import { useRef, type ReactNode } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { useCoveredTerminalFocusHandoff } from './chat/use-covered-terminal-focus-handoff'

/** The map cover owns focus for its pane so keystrokes never reach the hidden agent. */
export function AgentMapPaneCover({
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
      className="absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col bg-background focus:outline-none"
    >
      {children}
    </div>
  )
}
