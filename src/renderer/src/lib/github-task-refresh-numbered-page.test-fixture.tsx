import React, { useRef, useState } from 'react'
import { store, harnessSetPages } from './github-task-refresh.test-fixture'
import { repo } from './github-task-refresh-data.test-fixture'
import { VisibleReaders } from './github-task-refresh-visible-readers.test-fixture'
import { useTaskPageGitHubSearchPagination } from '@/components/task-page/github/use-task-page-github-search-pagination'
import type { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'
import { parseTaskQuery } from '../../../shared/task-query'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

export function NumberedPageReaders({
  pages,
  mutation,
  queryKey,
  viewerLogin
}: {
  pages: (readonly GitHubWorkItem[] | null)[]
  mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>
  queryKey: string
  viewerLogin: string | null
}) {
  const [currentPage, setCurrentPage] = useState(0)
  const [paginationLoading, setPaginationLoading] = useState(false)
  const pagesRef = useRef(pages),
    currentPageRef = useRef(currentPage)
  React.useLayoutEffect(() => {
    pagesRef.current = pages
    currentPageRef.current = currentPage
  }, [pages, currentPage])
  const noop = () => {}
  const navigation = useTaskPageGitHubSearchPagination({
    ...store.getState(),
    selectedRepos: [repo],
    appliedTaskSearch: 'is:open',
    appliedTaskQuery: parseTaskQuery('is:open'),
    githubWorkItemMutationQueryKey: queryKey,
    githubViewerLogin: viewerLogin,
    githubPageSize: 30,
    githubPerRepoPageLimit: 30,
    pagesRef,
    currentPageRef,
    currentPage,
    setCurrentPage,
    setPages: harnessSetPages,
    paginationLoading,
    setPaginationLoading,
    setLoadingTargetPage: noop,
    setCountedTotalPages: noop,
    setProvenPageLimit: noop,
    countedTotalPagesRef: useRef<number | null>(null),
    paginationGenerationRef: useRef(0),
    githubSearchPersistReadyRef: useRef(false),
    taskResumeApplied: false,
    taskSearchInput: '',
    activeTaskPreset: null,
    activeGithubTaskKind: 'issues',
    setAppliedTaskSearch: noop,
    setTasksFiltering: noop
  })
  return (
    <>
      <button onClick={() => void navigation.handleLoadNextPage(2)}>Load Cora page</button>
      <VisibleReaders
        pages={[null, null, pages[currentPage] ?? null]}
        mutation={mutation}
        queryKey={queryKey}
        query="is:open"
        viewerLogin={viewerLogin}
      />
    </>
  )
}
