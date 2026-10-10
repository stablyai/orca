// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { GitHubPrStartPoint } from '../../../../shared/worktree/types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { JiraIssue } from '../../../../shared/jira-types'
import { pr, mr, useReviewBaseSelectionFixture } from './composer-review-base-test-fixture'

const linear: LinearIssue = {
  id: 'linear-9',
  identifier: 'ENG-9',
  title: 'Current task',
  url: 'https://linear.app/fixture/issue/ENG-9',
  state: { name: 'Open', type: 'unstarted', color: '' },
  team: { id: 'engineering', name: 'Engineering', key: 'ENG' },
  labels: [],
  labelIds: [],
  priority: 0,
  updatedAt: ''
}
const jira: JiraIssue = {
  id: '9',
  key: 'APP-9',
  title: 'Current task',
  url: 'https://jira.example/browse/APP-9',
  project: { id: 'app', key: 'APP', name: 'App' },
  issueType: { id: 'bug', name: 'Bug' },
  status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To do' },
  labels: [],
  updatedAt: '',
  createdAt: ''
}
const staleBase: GitHubPrStartPoint = {
  baseBranch: 'stale-review-base',
  compareBaseRef: 'origin/stale-review-base',
  pushTarget: { remoteName: 'origin', branchName: 'stale-review-base' }
}
const resolvePrBase = vi.fn<Window['api']['worktrees']['resolvePrBase']>()
const resolveMrBase = vi.fn<Window['api']['worktrees']['resolveMrBase']>()
let originalApi: PropertyDescriptor | undefined

beforeEach(() => {
  originalApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { worktrees: { resolvePrBase, resolveMrBase } }
  })
  vi.spyOn(toast, 'error').mockImplementation(() => 'fixture-toast')
})
afterEach(() => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function deferred() {
  let resolve!: (value: GitHubPrStartPoint | { error: string }) => void
  let reject!: (error: Error) => void
  const promise = new Promise<GitHubPrStartPoint | { error: string }>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}
type State = ReturnType<typeof useReviewBaseSelectionFixture>
function snapshot(state: State) {
  const {
    name,
    linkedWorkItem,
    baseBranch,
    note,
    pushTarget,
    compareBaseRef,
    repoId,
    selectedProjectGroupId
  } = state
  return {
    name,
    linkedWorkItem,
    baseBranch,
    note,
    pushTarget,
    compareBaseRef,
    repoId,
    selectedProjectGroupId
  }
}
function select(state: State, provider: string, number = 2) {
  if (provider === 'github') {
    state.handleSmartGitHubItemSelect({
      ...pr,
      number,
      url: `https://github.com/fixture/repo/pull/${number}`
    })
  } else {
    state.handleSmartGitLabItemSelect({
      ...mr,
      number,
      url: `https://gitlab.com/fixture/repo/-/merge_requests/${number}`
    })
  }
}
async function complete(pending: ReturnType<typeof deferred>, outcome: string) {
  await act(async () => {
    if (outcome === 'success') {
      pending.resolve(staleBase)
    } else if (outcome === 'error-response') {
      pending.resolve({ error: 'Stale review failed' })
    } else {
      pending.reject(new Error('Stale review failed'))
    }
    await pending.promise.catch(() => undefined)
  })
}
const providers = ['github', 'gitlab']
const outcomes = ['success', 'error-response', 'rejection']
const actions = [
  'unlink',
  'github-issue',
  'gitlab-issue',
  'linear',
  'jira',
  'manual-base',
  'repo-change',
  'repo-preserve-source',
  'clear-source-pill',
  'direct-github-review',
  'direct-gitlab-review',
  'folder-project',
  'folder-source-repo',
  'smart-branch'
]
const canceledCases = providers.flatMap((provider) =>
  actions.flatMap((action) => outcomes.map((outcome) => ({ provider, action, outcome })))
)

describe('review base selection ownership', () => {
  it.each(canceledCases)(
    'ignores old $provider $outcome after $action',
    async ({ provider, action, outcome }) => {
      const pending = deferred()
      resolvePrBase.mockReturnValue(pending.promise)
      resolveMrBase.mockReturnValue(pending.promise)
      const { result } = renderHook(useReviewBaseSelectionFixture)
      act(() => select(result.current, provider))
      act(() => result.current.handleNameValueChange('002'))
      act(() => {
        const state = result.current
        if (action === 'unlink') {
          state.handleRemoveLinkedWorkItem()
        }
        if (action === 'github-issue') {
          state.handleSmartGitHubItemSelect({
            ...pr,
            type: 'issue',
            number: 347,
            url: 'https://github.com/fixture/repo/issues/347'
          })
        }
        if (action === 'gitlab-issue') {
          state.handleSmartGitLabItemSelect({
            ...mr,
            type: 'issue',
            number: 347,
            url: 'https://gitlab.com/fixture/repo/-/issues/347'
          })
        }
        if (action === 'linear') {
          state.handleSmartLinearIssueSelect(linear)
        }
        if (action === 'jira') {
          state.handleSmartJiraIssueSelect(jira, {
            kind: 'task-source',
            provider: 'jira',
            projectId: 'app',
            hostId: 'local'
          })
        }
        if (action === 'manual-base') {
          state.handleBaseBranchChange('replacement-base')
        }
        if (action === 'repo-change') {
          state.handleRepoChange('replacement-repo')
        }
        if (action === 'repo-preserve-source') {
          state.handleRepoChange('replacement-repo', { preserveStartFrom: true })
        }
        if (action === 'clear-source-pill') {
          state.handleClearSmartNameSelection()
        }
        if (action === 'folder-project' || action === 'folder-source-repo') {
          state.handleProjectChange('project-group:folder')
        }
        if (action === 'smart-branch') {
          state.handleSmartBranchSelect('origin/current-branch', 'current-branch')
        }
        if (action === 'direct-github-review') {
          state.handleBaseBranchPrSelect('current-review-base', {
            ...pr,
            number: 3,
            url: 'https://github.com/fixture/repo/pull/3'
          })
        }
        if (action === 'direct-gitlab-review') {
          state.handleBaseBranchMrSelect('current-review-base', {
            ...mr,
            number: 3,
            url: 'https://gitlab.com/fixture/repo/-/merge_requests/3'
          })
        }
      })
      if (action === 'folder-source-repo') {
        act(() => result.current.handleFolderSourceRepoChange('replacement-repo'))
      }
      if (action === 'folder-project' || action === 'folder-source-repo') {
        expect(result.current.selectedProjectGroupId).toBe('folder')
        expect(result.current.linkedWorkItem).toBeNull()
      }
      const before = snapshot(result.current)
      await complete(pending, outcome)

      expect(snapshot(result.current)).toEqual(before)
      expect(toast.error).not.toHaveBeenCalled()
    }
  )

  it.each(providers.flatMap((provider) => outcomes.map((outcome) => ({ provider, outcome }))))(
    'ignores replaced $provider $outcome after the newer review resolves',
    async ({ provider, outcome }) => {
      const old = deferred()
      const current = deferred()
      resolvePrBase.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
      resolveMrBase.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
      const { result } = renderHook(useReviewBaseSelectionFixture)
      act(() => select(result.current, provider))
      act(() => select(result.current, provider, 3))
      await act(async () => {
        current.resolve({ baseBranch: 'current-review-base' })
        await current.promise
      })
      const before = snapshot(result.current)
      await complete(old, outcome)

      expect(snapshot(result.current)).toEqual(before)
      expect(result.current.baseBranch).toBe('current-review-base')
      expect(toast.error).not.toHaveBeenCalled()
    }
  )

  it.each(providers)('applies a current %s success', async (provider) => {
    const pending = deferred()
    resolvePrBase.mockReturnValue(pending.promise)
    resolveMrBase.mockReturnValue(pending.promise)
    const { result } = renderHook(useReviewBaseSelectionFixture)
    act(() => select(result.current, provider))
    await complete(pending, 'success')

    expect(result.current.baseBranch).toBe(staleBase.baseBranch)
    expect(result.current.pushTarget).toEqual(staleBase.pushTarget)
    expect(result.current.compareBaseRef).toBe(staleBase.compareBaseRef)
    expect(result.current.note).toBe(
      provider === 'github' ? 'PR #2 — Fix export' : 'MR !2 — Fix export'
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each(
    providers.flatMap((provider) =>
      ['error-response', 'rejection'].map((outcome) => ({ provider, outcome }))
    )
  )('reports a current $provider $outcome', async ({ provider, outcome }) => {
    const pending = deferred()
    resolvePrBase.mockReturnValue(pending.promise)
    resolveMrBase.mockReturnValue(pending.promise)
    const { result } = renderHook(useReviewBaseSelectionFixture)
    act(() => select(result.current, provider))
    await complete(pending, outcome)

    expect(toast.error).toHaveBeenCalledWith('Stale review failed')
    expect(result.current.baseBranch).toBeUndefined()
  })
})
