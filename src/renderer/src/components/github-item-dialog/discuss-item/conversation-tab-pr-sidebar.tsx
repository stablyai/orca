import React from 'react'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { PRAssigneesPanel } from '@/components/github/PRAssigneesPanel'
import type { GitHubItemDialogProjectOrigin } from '../load-item-details/github-item-dialog-types'
import { ChecksTab } from '../inspect-pull-request/checks-tab'
import { PRActionsPanel } from '../land-pull-request/pr-actions-panel'
import { PRReviewersPanel } from '../land-pull-request/pr-reviewers-panel'

export function ConversationTabPRSidebar({
  item,
  repoPath,
  sourceContext,
  projectOrigin,
  localState,
  onStateChange,
  onMutated,
  loading,
  detailsLoaded,
  headSha,
  checks,
  onChecksUpdated,
  onReviewersRequested
}: {
  item: GitHubWorkItem
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  localState: GitHubWorkItem['state']
  onStateChange: (state: GitHubWorkItem['state']) => void
  onMutated: () => void
  loading: boolean
  detailsLoaded: boolean
  headSha: string | undefined
  checks: GitHubWorkItemDetails['checks']
  onChecksUpdated: (checks: PRCheckDetail[]) => void
  onReviewersRequested: (reviewRequests: GitHubAssignableUser[]) => void
}): React.JSX.Element {
  return (
    <div className="flex h-fit flex-col gap-5 xl:sticky xl:top-4">
      <PRActionsPanel
        item={item}
        repoPath={repoPath}
        repoId={item.repoId}
        sourceContext={sourceContext}
        projectOrigin={projectOrigin}
        localState={localState}
        onStateChange={onStateChange}
        onMutated={onMutated}
      />
      <PRAssigneesPanel
        item={item}
        repoPath={repoPath}
        projectOrigin={projectOrigin}
        sourceContext={sourceContext}
        onMutated={onMutated}
      />
      <PRReviewersPanel
        item={item}
        loading={loading}
        repoPath={repoPath}
        sourceContext={sourceContext}
        projectOrigin={projectOrigin}
        onReviewersRequested={onReviewersRequested}
      />
      <aside className="overflow-hidden rounded-lg border border-border/50 bg-card/50 shadow-xs">
        <ChecksTab
          item={item}
          repoPath={repoPath}
          repoId={item.repoId}
          sourceContext={sourceContext}
          headSha={headSha}
          checks={checks}
          loading={loading || !detailsLoaded}
          onChecksUpdated={onChecksUpdated}
        />
      </aside>
    </div>
  )
}
