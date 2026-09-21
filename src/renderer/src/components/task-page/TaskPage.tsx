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
import { useTaskPageResumeRestoration } from '../use-task-page-resume-restoration'
import { useTaskPageProviderMetadata } from '../use-task-page-provider-metadata'
import { useTaskPageGitLabLoading } from '../use-task-page-gitlab-loading'
import { useTaskPageLinearListSelection } from '../use-task-page-linear-list-selection'
import { useTaskPageLinearListProjection } from '../use-task-page-linear-list-projection'
import { useTaskPageLinearBoard } from '../use-task-page-linear-board'
import { useTaskPageJiraListProjection } from '../use-task-page-jira-list-projection'
import { useTaskPageLinearCreationState } from '../use-task-page-linear-creation-state'
import { useTaskPageGitHubMutationState } from '../use-task-page-github-mutation-state'
import { useTaskPageJiraCreationState } from '../use-task-page-jira-creation-state'
import { useTaskPageJiraCreationMetadata } from '../use-task-page-jira-creation-metadata'
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
import { useTaskPageGlobalEffects } from '../use-task-page-global-effects'
import { useTaskPageLinearListEffects } from '../use-task-page-linear-list-effects'
import { useTaskPageLinearInOrcaEffects } from '../use-task-page-linear-in-orca-effects'
import { useTaskPageLinearCollectionEffects } from '../use-task-page-linear-collection-effects'
import { useTaskPageJiraListEffects } from '../use-task-page-jira-list-effects'
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
  const stage13 = useTaskPageResumeRestoration(stage12)
  const stage14 = useTaskPageProviderMetadata(stage13)
  const stage15 = useTaskPageGitLabLoading(stage14)
  const stage16 = useTaskPageLinearListSelection(stage15)
  const stage17 = useTaskPageLinearListProjection(stage16)
  const stage18 = useTaskPageLinearBoard(stage17)
  const stage19 = useTaskPageJiraListProjection(stage18)
  const stage20 = useTaskPageLinearCreationState(stage19)
  const stage21 = useTaskPageGitHubMutationState(stage20)
  const stage22 = useTaskPageJiraCreationState(stage21)
  const stage23 = useTaskPageJiraCreationMetadata(stage22)
  const stage24 = useTaskPageGitHubListProjection(stage23)
  const stage25 = useTaskPageGitHubSearchPagination(stage24)
  const stage26 = useTaskPageGitHubLandingRefresh(stage25)
  const stage27 = useTaskPageGitHubQuietRefresh(stage26)
  const stage28 = useTaskPageSearchActions(stage27)
  const stage29 = useTaskPageWorkspaceActions(stage28)
  const stage30 = useTaskPageGitHubIssueCreation(stage29)
  const stage31 = useTaskPageLinearProjectCreation(stage30)
  const stage32 = useTaskPageLinearIssueCreation(stage31)
  const stage33 = useTaskPageJiraIssueCreation(stage32)
  const stage34 = useTaskPageGlobalEffects(stage33)
  const stage35 = useTaskPageLinearListEffects(stage34)
  const stage36 = useTaskPageLinearInOrcaEffects(stage35)
  const stage37 = useTaskPageLinearCollectionEffects(stage36)
  const stage38 = useTaskPageJiraListEffects(stage37)
  const stage39 = useTaskPageComposerActions(stage38)
  return <TaskPageSurface model={stage39} />
}
