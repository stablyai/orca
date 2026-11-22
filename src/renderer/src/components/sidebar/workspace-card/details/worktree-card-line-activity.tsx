import React from 'react'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import { findIndexedWorktrees } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
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
import {
  applyAgentPaneActivityFlags,
  createAgentPaneActivityFlags,
  rankWorktreeStatus
} from '../../../../../../shared/worktree/row-display/worktree-status-rollup'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { worktreeCopyOwnerKey } from '@/store/slices/worktrees/metadata/worktree-copy-review-clear'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

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
  const workspaceStatus = useWorktreeActivityStatus(worktreeId)
  const agents = useWorktreeAgentRows(worktreeId, true, executionHostId)
  const hasHostCopies = useAppStateValue((state) => {
    const copies = findIndexedWorktrees(selectWorktreesByRepo(state), worktreeId)
    if (copies.length < 2) {
      return false
    }
    const firstOwner = worktreeCopyOwnerKey(copies[0])
    return copies.some((copy) => worktreeCopyOwnerKey(copy) !== firstOwner)
  })
  let status = workspaceStatus
  if (hasHostCopies) {
    // The bare-ID rollup cannot attribute terminal titles or permission to one copy.
    const flags = createAgentPaneActivityFlags()
    for (const { entry, state } of agents) {
      if (state === entry.state && !entry.restoredUnconfirmed) {
        applyAgentPaneActivityFlags(flags, entry)
      }
    }
    status = rankWorktreeStatus('active', flags)
  }
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
