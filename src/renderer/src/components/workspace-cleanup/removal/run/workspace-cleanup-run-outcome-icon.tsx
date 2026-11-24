import React from 'react'
import { Check, TriangleAlert } from 'lucide-react'

export function WorkspaceCleanupRunOutcomeIcon({
  hasFailures
}: {
  hasFailures: boolean
}): React.JSX.Element {
  return hasFailures ? (
    <TriangleAlert className="size-4 shrink-0 text-status-warning-text" aria-hidden="true" />
  ) : (
    <Check className="size-4 shrink-0 text-status-success" aria-hidden="true" />
  )
}
