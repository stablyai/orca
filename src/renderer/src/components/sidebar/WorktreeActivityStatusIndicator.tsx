import React from 'react'
import { getWorktreeStatusLabel } from '@/lib/worktree-status'
import StatusIndicator from './StatusIndicator'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'

export function WorktreeActivityStatusIndicator({
  worktreeId,
  className
}: {
  worktreeId: string
  className?: string
}): React.JSX.Element {
  const status = useWorktreeActivityStatus(worktreeId)

  return (
    <>
      <StatusIndicator status={status} aria-hidden="true" className={className} />
      <span className="sr-only">{getWorktreeStatusLabel(status)}</span>
    </>
  )
}
