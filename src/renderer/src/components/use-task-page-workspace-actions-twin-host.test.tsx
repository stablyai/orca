// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskPageSearchActionsModel } from './use-task-page-search-actions'
import { useTaskPageWorkspaceActions } from './use-task-page-workspace-actions'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ recordFeatureInteraction: vi.fn() }) }
}))

const sshRow: Repo = {
  id: 'twin',
  path: '/remote/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1,
  connectionId: 'builder'
}
const localRow: Repo = { ...sshRow, path: '/laptop/twin', addedAt: 2, connectionId: undefined }
const pr: GitHubWorkItem = {
  id: 'pr-7',
  type: 'pr',
  number: 7,
  title: 'Fix it',
  state: 'open',
  url: 'https://github.com/o/r/pull/7',
  labels: [],
  updatedAt: '2026-10-20T00:00:00Z',
  author: 'octo',
  repoId: 'twin',
  repoHostId: 'ssh:builder'
}

const mr: GitLabWorkItem = {
  id: 'mr-9',
  type: 'mr',
  number: 9,
  title: 'Fix it on GitLab',
  state: 'opened',
  url: 'https://gitlab.com/o/r/-/merge_requests/9',
  labels: [],
  updatedAt: '2026-10-20T00:00:00Z',
  author: 'octo',
  repoId: 'twin',
  repoHostId: 'ssh:builder'
}

function renderTwinActions() {
  const openModal = vi.fn()
  const repos = [sshRow, localRow]
  // By id a map keeps the last twin, which is the row that did not return the item.
  const model = { repos, repoMap: new Map(repos.map((repo) => [repo.id, repo])), openModal }
  const { result } = renderHook(() =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these fields.
    useTaskPageWorkspaceActions(model as unknown as TaskPageSearchActionsModel)
  )
  return { openModal, actions: result.current }
}

describe('starting work from a card on a repo id two hosts share', () => {
  it('opens the composer for the host that returned the GitLab MR', () => {
    const { openModal, actions } = renderTwinActions()

    actions.handleUseGitLabItem(mr)

    expect(openModal).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({
        taskSourceContext: expect.objectContaining({ hostId: 'ssh:builder', repoId: 'twin' })
      })
    )
  })

  it('opens the composer for the host that returned the PR', () => {
    const { openModal, actions } = renderTwinActions()

    actions.handleUseWorkItem(pr)

    expect(openModal).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({
        taskSourceContext: expect.objectContaining({ hostId: 'ssh:builder', repoId: 'twin' })
      })
    )
  })
})
