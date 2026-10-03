import React from 'react'
import { useTaskPageStoreBindings } from '../use-task-page-store-bindings'
import { useTaskPageRepoSelection } from '../use-task-page-repo-selection'
import { useTaskPageRuntimeHosts } from '../use-task-page-runtime-hosts'
import { useTaskPageSourceAvailability } from '../use-task-page-source-availability'
import { useTaskPageProviderState } from '../use-task-page-provider-state'
import { useTaskPageGitHubListState } from '../use-task-page-github-list-state'
import { useTaskPageGitHubDetail } from '../use-task-page-github-detail'
import { useTaskPageGitHubCacheReconciliation } from '../use-task-page-github-cache-reconciliation'
import { useTaskPageGitHubIssueDraft } from '../use-task-page-github-issue-draft'
import { useTaskPageDetailRouting } from '../use-task-page-detail-routing'
import { useTaskPageLinearViewState } from '../use-task-page-linear-view-state'
import { useTaskPageJiraListState } from '../use-task-page-jira-list-state'
import { useTaskPageBusinessmapListState } from '../use-task-page-businessmap-list-state'
import { useTaskPageResumeRestoration } from '../use-task-page-resume-restoration'
import { useTaskPageProviderMetadata } from '../use-task-page-provider-metadata'
import { useTaskPageGitLabLoading } from '../use-task-page-gitlab-loading'
import { useTaskPageLinearListSelection } from '../use-task-page-linear-list-selection'
import { useTaskPageLinearListProjection } from '../use-task-page-linear-list-projection'
import { useTaskPageLinearBoard } from '../use-task-page-linear-board'
import { useTaskPageJiraListProjection } from '../use-task-page-jira-list-projection'
import { useTaskPageBusinessmapListProjection } from '../use-task-page-businessmap-list-projection'
import { useTaskPageLinearCreationState } from '../use-task-page-linear-creation-state'
import { useTaskPageGitHubMutationState } from '../use-task-page-github-mutation-state'
import { useTaskPageJiraCreationState } from '../use-task-page-jira-creation-state'
import { useTaskPageJiraCreationMetadata } from '../use-task-page-jira-creation-metadata'
import { useTaskPageBusinessmapCreationState } from '../use-task-page-businessmap-creation-state'
import { useTaskPageBusinessmapCreationMetadata } from '../use-task-page-businessmap-creation-metadata'
import { useTaskPageGitHubListProjection } from '../use-task-page-github-list-projection'
import { useTaskPageGitHubSearchPagination } from '../use-task-page-github-search-pagination'
import { useTaskPageGitHubLandingRefresh } from '../use-task-page-github-landing-refresh'
import { useTaskPageGitHubQuietRefresh } from '../use-task-page-github-quiet-refresh'
import { useTaskPageSearchActions } from '../use-task-page-search-actions'
import { useTaskPageWorkspaceActions } from '../use-task-page-workspace-actions'
import { useTaskPageGitHubIssueCreation } from '../use-task-page-github-issue-creation'
import { useTaskPageLinearProjectCreation } from '../use-task-page-linear-project-creation'
import { useTaskPageLinearIssueCreation } from '../use-task-page-linear-issue-creation'
import { useTaskPageJiraIssueCreation } from '../use-task-page-jira-issue-creation'
import { useTaskPageBusinessmapCardCreation } from '../use-task-page-businessmap-card-creation'
import { useTaskPageGlobalEffects } from '../use-task-page-global-effects'
import { useTaskPageLinearListEffects } from '../use-task-page-linear-list-effects'
import { useTaskPageLinearInOrcaEffects } from '../use-task-page-linear-in-orca-effects'
import { useTaskPageLinearCollectionEffects } from '../use-task-page-linear-collection-effects'
import { useTaskPageJiraListEffects } from '../use-task-page-jira-list-effects'
import { useTaskPageBusinessmapListEffects } from '../use-task-page-businessmap-list-effects'
import { useTaskPageComposerActions } from '../use-task-page-composer-actions'
import { TaskPageSurface } from './Surface'

export default function TaskPage(): React.JSX.Element {
  const stage1 = useTaskPageStoreBindings()
  const stage2 = useTaskPageRepoSelection(stage1)
  const stage3 = useTaskPageRuntimeHosts(stage2)
  const stage4 = useTaskPageSourceAvailability(stage3)
  const stage5 = useTaskPageProviderState(stage4)
  const stage6 = useTaskPageGitHubListState(stage5)
  const stage7 = useTaskPageGitHubDetail(stage6)
  const stage8 = useTaskPageGitHubCacheReconciliation(stage7)
  const stage9 = useTaskPageGitHubIssueDraft(stage8)
  const stage10 = useTaskPageDetailRouting(stage9)
  const stage11 = useTaskPageLinearViewState(stage10)
  const stage12 = useTaskPageJiraListState(stage11)
  const stage13 = useTaskPageBusinessmapListState(stage12)
  const stage14 = useTaskPageResumeRestoration(stage13)
  const stage15 = useTaskPageProviderMetadata(stage14)
  const stage16 = useTaskPageGitLabLoading(stage15)
  const stage17 = useTaskPageLinearListSelection(stage16)
  const stage18 = useTaskPageLinearListProjection(stage17)
  const stage19 = useTaskPageLinearBoard(stage18)
  const stage20 = useTaskPageJiraListProjection(stage19)
  const stage21 = useTaskPageBusinessmapListProjection(stage20)
  const stage22 = useTaskPageLinearCreationState(stage21)
  const stage23 = useTaskPageGitHubMutationState(stage22)
  const stage24 = useTaskPageJiraCreationState(stage23)
  const stage25 = useTaskPageJiraCreationMetadata(stage24)
  const stage26 = useTaskPageBusinessmapCreationState(stage25)
  const stage27 = useTaskPageBusinessmapCreationMetadata(stage26)
  const stage28 = useTaskPageGitHubListProjection(stage27)
  const stage29 = useTaskPageGitHubSearchPagination(stage28)
  const stage30 = useTaskPageGitHubLandingRefresh(stage29)
  const stage31 = useTaskPageGitHubQuietRefresh(stage30)
  const stage32 = useTaskPageSearchActions(stage31)
  const stage33 = useTaskPageWorkspaceActions(stage32)
  const stage34 = useTaskPageGitHubIssueCreation(stage33)
  const stage35 = useTaskPageLinearProjectCreation(stage34)
  const stage36 = useTaskPageLinearIssueCreation(stage35)
  const stage37 = useTaskPageJiraIssueCreation(stage36)
  const stage38 = useTaskPageBusinessmapCardCreation(stage37)
  const stage39 = useTaskPageGlobalEffects(stage38)
  const stage40 = useTaskPageLinearListEffects(stage39)
  const stage41 = useTaskPageLinearInOrcaEffects(stage40)
  const stage42 = useTaskPageLinearCollectionEffects(stage41)
  const stage43 = useTaskPageJiraListEffects(stage42)
  const stage44 = useTaskPageBusinessmapListEffects(stage43)
  const stage45 = useTaskPageComposerActions(stage44)
  return <TaskPageSurface model={stage45} />
}
