import React from 'react'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import { DetailHeader } from '../metadata/WorktreeCardMetadataControls'
import WorktreeCardAgents from '../activity/WorktreeCardAgents'
import { WorktreeCardDetailSection } from './WorktreeCardDetailSection'
import StatusIndicator from '../surface/StatusIndicator'
import { useWorktreeActivityStatus } from '../activity/use-worktree-activity-status'
import { useWorktreeAgentRows } from '../activity/useWorktreeAgentRows'

/** A one-line card's status and agent rows, which the line itself has no room for. */
export function WorktreeCardLineActivity({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const status = useWorktreeActivityStatus(worktreeId)
  const agents = useWorktreeAgentRows(worktreeId)
  if (agents.length === 0 && status !== 'permission') {
    return null
  }
  return (
    <WorktreeCardDetailSection data-worktree-card-line-activity="">
      <DetailHeader
        icon={<StatusIndicator status={status} showTooltip={false} />}
        label={getWorktreeStatusLabel(status)}
      />
      <WorktreeCardAgents worktreeId={worktreeId} />
    </WorktreeCardDetailSection>
  )
}
