// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { WorkspaceSpaceIssueFreshness } from './workspace-space-issue-freshness'

let container: HTMLDivElement
let root: Root
const fetchIssue = vi.fn(async () => null)

function linkIssue(linkedIssue: number | null): void {
  useAppStore.setState({
    repos: [{ id: 'repo-1', path: '/repos/one', displayName: 'one', kind: 'git' }],
    worktreesByRepo: {
      'repo-1': [{ id: 'repo-1::/wt/a', repoId: 'repo-1', path: '/wt/a', branch: 'a', linkedIssue }]
    },
    fetchIssue
  } as unknown as Partial<AppState>)
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  fetchIssue.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'api')
  window.history.replaceState(null, '', '/')
})

it('reads the live linked issue while open, following a late and a changed link', () => {
  const requestIssueRefresh = vi.fn(async () => {})
  Object.assign(window, { api: { workspaceSpace: { requestIssueRefresh } } })
  const show = (issueCacheKey: string | null): void =>
    act(() =>
      root.render(
        <WorkspaceSpaceIssueFreshness worktreeId="repo-1::/wt/a" issueCacheKey={issueCacheKey} />
      )
    )
  linkIssue(null)
  show(null)
  expect(fetchIssue).not.toHaveBeenCalled()

  linkIssue(91)
  show('repo-1::91')
  expect(fetchIssue).toHaveBeenLastCalledWith('/repos/one', 91, { repoId: 'repo-1' })

  linkIssue(92)
  show('repo-1::92')
  expect(fetchIssue).toHaveBeenLastCalledWith('/repos/one', 92, { repoId: 'repo-1' })
  expect(requestIssueRefresh).not.toHaveBeenCalled()
})

it('asks the main window, which owns the issue cache, from the desktop Space window', () => {
  const requestIssueRefresh = vi.fn(async () => {})
  Object.assign(window, { api: { workspaceSpace: { requestIssueRefresh } } })
  window.history.replaceState(null, '', '/space.html')
  linkIssue(91)
  act(() =>
    root.render(
      <WorkspaceSpaceIssueFreshness worktreeId="repo-1::/wt/a" issueCacheKey="repo-1::91" />
    )
  )

  expect(requestIssueRefresh).toHaveBeenCalledWith('repo-1::/wt/a', undefined)
  expect(fetchIssue).not.toHaveBeenCalled()
})
