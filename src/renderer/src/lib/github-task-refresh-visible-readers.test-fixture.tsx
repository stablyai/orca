import { store } from './github-task-refresh.test-fixture'

import { parseTaskQuery } from '../../../shared/task-query'

import React from 'react'

import { useStore } from 'zustand'

import { TaskPageGitHubRows } from '@/components/task-page/github/Rows'
import { useTaskPageGitHubListProjection } from '@/components/task-page/github/use-task-page-github-list-projection'
import { ProjectAssigneesCell } from '@/components/github-project/ProjectCellRepositoryEditors'
import ProjectBoardCard from '@/components/github-project/ProjectBoardCard'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

export function VisibleReaders({
  pages,
  mutation,
  queryKey = 'q',
  query = 'is:open assignee:bob',
  viewerLogin = null,
  kind = 'issues'
}: {
  queryKey?: string
  viewerLogin?: string | null
  query?: string
  kind?: 'issues' | 'prs'
  pages: (GitHubWorkItem[] | null)[]
  mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>
}) {
  const projects = useStore(store, (state) => state.projectViewCache)
  // SAFETY: the real issue projection/rows read only this slice of the full composer model.
  const model = {
    repos: store.getState().repos,
    allWorktrees: [],
    selectedRepos: store.getState().repos,
    taskSource: 'github',
    githubMode: 'items',
    activeGithubTaskKind: kind,
    tasksLoading: false,
    tasksFiltering: false,
    githubPageSize: 30,
    pages,
    currentPage: 2,
    perRepoSourceState: [],
    appliedTaskQuery: parseTaskQuery(query),
    githubWorkItemMutationQueryKey: queryKey,
    githubViewerLogin: viewerLogin,
    githubWorkItemMutation: mutation,
    countedTotalPages: null,
    provenPageLimit: null,
    fetchPRChecks: store.getState().fetchPRChecks,
    patchTaskPageWorkItemRows: () => {},
    openGitHubDetailPage: () => {},
    handleUseWorkItem: () => {},
    handleOpenOrUseGitHubWorkItem: () => {}
  } satisfies Parameters<typeof useTaskPageGitHubListProjection>[0] &
    Omit<
      Parameters<typeof TaskPageGitHubRows>[0]['model'],
      | 'filteredWorkItems'
      | 'showGitHubTaskSkeletons'
      | 'showPRManagementColumns'
      | 'githubTaskGridClass'
      | 'ensurePRChecksLoaded'
    >
  const projection = useTaskPageGitHubListProjection(model)
  return (
    <>
      <output data-visible-count>{projection.filteredWorkItems.length}</output>
      <section data-tasks>
        <TaskPageGitHubRows model={projection} />
      </section>
      {Object.entries(projects).map(([cacheKey, entry]) =>
        entry.data?.rows.map((row) => (
          <section key={`${cacheKey}:${row.id}`} data-project-output={`${cacheKey}:${row.id}`}>
            <div data-list-chips>
              <ProjectAssigneesCell row={row} editable={false} sourceTarget={{ kind: 'local' }} />
            </div>
            <ProjectBoardCard row={row} draggable={false} onDragStart={() => {}} />
          </section>
        ))
      )}
    </>
  )
}
