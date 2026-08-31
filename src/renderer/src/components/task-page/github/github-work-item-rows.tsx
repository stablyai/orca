import React from 'react'

import type { ItemDialogTab } from '@/components/GitHubItemDialog'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { TaskPageGitHubWorkItemMutationRunner } from './github-work-item-mutation-runner'
import { GithubWorkItemRow } from './github-work-item-row'

export type GithubWorkItemRowsProps = {
  showGitHubTaskSkeletons: boolean
  filteredWorkItems: readonly GitHubWorkItem[]
  repoMap: ReadonlyMap<string, Repo>
  allWorktrees: readonly Worktree[]
  selectedRepoCount: number
  showPRManagementColumns: boolean
  githubTaskGridClass: string
  openGitHubDetailPage: (item: GitHubWorkItem, tab?: ItemDialogTab) => void
  githubWorkItemMutation: TaskPageGitHubWorkItemMutationRunner
  ensurePRChecksLoaded: (item: GitHubWorkItem) => void
  handleOpenOrUseGitHubWorkItem: (item: GitHubWorkItem) => void
  handleUseWorkItem: (item: GitHubWorkItem) => void
}

export function GithubWorkItemRows({
  showGitHubTaskSkeletons,
  filteredWorkItems,
  repoMap,
  allWorktrees,
  selectedRepoCount,
  showPRManagementColumns,
  githubTaskGridClass,
  openGitHubDetailPage,
  githubWorkItemMutation,
  ensurePRChecksLoaded,
  handleOpenOrUseGitHubWorkItem,
  handleUseWorkItem
}: GithubWorkItemRowsProps): React.JSX.Element {
  return (
    <div className="divide-y divide-border/40">
      {!showGitHubTaskSkeletons &&
        filteredWorkItems.map((item) => {
          const itemRepo = repoMap.get(item.repoId) ?? null
          return (
            <GithubWorkItemRow
              key={`${item.repoId}:${item.id}`}
              item={item}
              itemRepo={itemRepo}
              allWorktrees={allWorktrees}
              selectedRepoCount={selectedRepoCount}
              showPRManagementColumns={showPRManagementColumns}
              githubTaskGridClass={githubTaskGridClass}
              openGitHubDetailPage={openGitHubDetailPage}
              githubWorkItemMutation={githubWorkItemMutation}
              ensurePRChecksLoaded={ensurePRChecksLoaded}
              handleOpenOrUseGitHubWorkItem={handleOpenOrUseGitHubWorkItem}
              handleUseWorkItem={handleUseWorkItem}
            />
          )
        })}
    </div>
  )
}
