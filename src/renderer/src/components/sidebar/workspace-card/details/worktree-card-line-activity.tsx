import React from 'react'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import { DetailHeader } from '../metadata/WorktreeCardMetadataControls'
import WorktreeCardAgents from '../activity/WorktreeCardAgents'
import { WorktreeCardDetailSection } from './WorktreeCardDetailSection'
import StatusIndicator from '../surface/StatusIndicator'
import { useWorktreeActivityStatus } from '../activity/use-worktree-activity-status'
import { useWorktreeAgentRows } from '../activity/useWorktreeAgentRows'
import {
  WORKTREE_CONTEXT_MENU_PORTAL_SCOPE_ATTR,
  WorktreeContextMenuPortalScope
} from '../../workspace-actions/context-menu/worktree-context-menu-policy'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'

/** A one-line card's status and agent rows, which the line itself has no room for. */
export function WorktreeCardLineActivity({
  worktreeId,
  executionHostId,
  workspaceMenuEnabled
}: {
  worktreeId: string
  executionHostId: ExecutionHostId
  workspaceMenuEnabled: boolean
}): React.JSX.Element | null {
  const menuScope = React.useContext(WorktreeContextMenuPortalScope)
  const status = useWorktreeActivityStatus(worktreeId)
  const agents = useWorktreeAgentRows(worktreeId, true, executionHostId)
  if (agents.length === 0 && status !== 'permission') {
    return null
  }
  return (
    <WorktreeCardDetailSection data-worktree-card-line-activity="">
      <DetailHeader
        icon={<StatusIndicator status={status} showTooltip={false} />}
        label={getWorktreeStatusLabel(status)}
      />
      <div
        {...{
          [WORKTREE_CONTEXT_MENU_PORTAL_SCOPE_ATTR]: workspaceMenuEnabled ? menuScope : undefined
        }}
      >
        <WorktreeCardAgents worktreeId={worktreeId} executionHostId={executionHostId} />
      </div>
    </WorktreeCardDetailSection>
  )
}
