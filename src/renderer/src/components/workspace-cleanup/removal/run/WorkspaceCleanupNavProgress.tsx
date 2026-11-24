import React from 'react'
import { Loader2 } from 'lucide-react'
import {
  getWorkspaceCleanupRunCounts,
  getWorkspaceCleanupRunPhase,
  useWorkspaceCleanupRunStore
} from './workspace-cleanup-run-store'

/** Spinner and done/total beside the Settings nav entry while a delete runs. */
export function WorkspaceCleanupNavProgress(): React.JSX.Element | null {
  const run = useWorkspaceCleanupRunStore((s) => s.run)
  if (run === null || getWorkspaceCleanupRunPhase(run) !== 'running') {
    return null
  }
  const { deleted, total } = getWorkspaceCleanupRunCounts(run)
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
      <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {deleted}/{total}
    </span>
  )
}
