import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { changePullRequestState, mergePullRequest } from './merge-actions'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  runPullRequestStateUpdate: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('@/components/github/github-work-item-edit-mutations', () => ({
  runPullRequestStateUpdate: mocks.runPullRequestStateUpdate
}))

const item = {
  id: 'pr:7',
  type: 'pr',
  number: 7,
  repoId: 'repo-1',
  state: 'open'
} as GitHubWorkItem

function recordEvents(): {
  events: string[]
  setPending: (value: boolean) => void
  applyStatePatch: (state: GitHubWorkItem['state']) => void
  onMutated: () => void
} {
  const events: string[] = []
  return {
    events,
    setPending: (value) => events.push(`pending:${value}`),
    applyStatePatch: (state) => events.push(`patch:${state}`),
    onMutated: () => events.push('reread')
  }
}

describe('PR page actions reconcile after failed writes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('rereads after a returned merge failure without applying the merged patch', async () => {
    const mergePR = vi.fn().mockResolvedValue({ ok: false, error: 'Connection lost' })
    vi.stubGlobal('window', { api: { gh: { mergePR } } })
    const recorder = recordEvents()

    await mergePullRequest({
      mergeDisabled: false,
      method: 'squash',
      item,
      repoPath: '/repo',
      repoId: 'repo-1',
      prRepo: null,
      mergeTarget: { kind: 'local' },
      confirm: vi.fn().mockResolvedValue(true),
      setMergePending: recorder.setPending,
      applyStatePatch: recorder.applyStatePatch,
      onMutated: recorder.onMutated
    })

    expect(mergePR).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledWith('Connection lost')
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(recorder.events).toEqual(['pending:true', 'pending:false', 'reread'])
  })

  it('rereads after reverting a thrown close', async () => {
    mocks.runPullRequestStateUpdate.mockRejectedValue(new Error('Connection lost'))
    const recorder = recordEvents()

    await changePullRequestState({
      canMutateState: true,
      statePending: false,
      nextState: 'closed',
      localState: 'open',
      item,
      repoPath: '/repo',
      repoId: 'repo-1',
      projectOrigin: undefined,
      prRepo: null,
      confirm: vi.fn().mockResolvedValue(true),
      setStatePending: recorder.setPending,
      applyStatePatch: recorder.applyStatePatch,
      onMutated: recorder.onMutated
    })

    expect(mocks.toastError).toHaveBeenCalledWith('Connection lost')
    expect(recorder.events).toEqual([
      'pending:true',
      'patch:closed',
      'patch:open',
      'pending:false',
      'reread'
    ])
  })
})
