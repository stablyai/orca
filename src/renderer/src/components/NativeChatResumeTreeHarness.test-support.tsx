// The resume tree mounted with selection state, as the dialog owns it, for the tree's tests.

import { useState } from 'react'
import { ResumeOnRestartGroups } from './NativeChatResumeOnRestartGroups'
import { TooltipProvider } from './ui/tooltip'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import { onToggleSpy } from './native-chat-resume-tree.test-support'

/** Owns the selection the way the dialog does, so group toggles show their effect. */
export function ResumeTreeHarness({
  candidates,
  initiallySelected,
  busy = false,
  failureFor
}: {
  candidates: ResumeCandidate[]
  initiallySelected?: string[]
  busy?: boolean
  failureFor?: (sessionId: string) => ResumeFailure | undefined
}): React.JSX.Element {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initiallySelected ?? candidates.map((entry) => entry.sessionId))
  )
  return (
    <TooltipProvider>
      <ResumeOnRestartGroups
        candidates={candidates}
        listedAt={1_800_000_060_000}
        busy={busy}
        selected={selected}
        onToggle={(sessionId, checked) => {
          onToggleSpy(sessionId, checked)
          setSelected((current) => {
            const next = new Set(current)
            if (checked) {
              next.add(sessionId)
            } else {
              next.delete(sessionId)
            }
            return next
          })
        }}
        failureFor={failureFor}
      />
    </TooltipProvider>
  )
}
