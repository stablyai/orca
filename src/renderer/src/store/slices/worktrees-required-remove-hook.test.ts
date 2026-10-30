import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'
import { __resetTrustPromptChainForTests } from '@/lib/ensure-hooks-confirmed'

beforeEach(() => {
  vi.clearAllMocks()
  resetWorktreeSliceModuleMemory()
  __resetTrustPromptChainForTests()
  mockApi.hooks.check.mockResolvedValue({
    status: 'ok',
    hasHooks: false,
    hooks: null,
    mayNeedUpdate: false,
    supportsRemoveHook: true,
    effectiveRemoveScript: 'dispose',
    effectiveRemoveHookHash: '4a299b459fdefa259987e40b38e523e3a69ed42ec789f26f7a652d48d7eb8316'
  })
})

describe('required removal consent at the deletion boundary', () => {
  it('labels the selected host copy rather than a same-id workspace on another host', async () => {
    const store = createTestStore()
    const local = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      hostId: 'local',
      displayName: 'Selected local task',
      path: '/path/wt1'
    })
    const remote = makeWorktree({
      ...local,
      hostId: 'runtime:other',
      displayName: 'Other host task'
    })
    let shown: Record<string, unknown> | undefined
    store.setState({
      settings: { ...getDefaultSettings('/home'), skipDeleteWorktreeConfirm: true },
      worktreesByRepo: { repo1: [remote, local] },
      openModal: (_modal, data) => {
        shown = data
        if (typeof data?.onResolve === 'function') {
          data.onResolve('skip')
        }
      }
    })
    await store.getState().removeWorktree({ id: local.id, executionHostId: 'local' }, true)
    expect(shown).toMatchObject({
      workspaceName: 'Selected local task',
      workspacePath: '/path/wt1'
    })
    expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
  })
  it.each(['skip', 'run'] as const)(
    'honors %s despite saved trust and skipped delete confirmations',
    async (decision) => {
      const store = createTestStore()
      const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1' })
      store.setState({
        settings: { ...getDefaultSettings('/home'), skipDeleteWorktreeConfirm: true },
        trustedOrcaHooks: { repo1: { all: { approvedAt: 1 } } },
        worktreesByRepo: { repo1: [wt] },
        openModal: (_modal, data) => {
          if (typeof data?.onResolve === 'function') {
            data.onResolve(decision)
          }
        }
      })
      const result = await store
        .getState()
        .removeWorktree({ id: wt.id, executionHostId: 'local' }, true, {
          allowFailedArchiveHook: true
        })
      if (decision === 'skip') {
        expect(result.ok).toBe(false)
        expect(mockApi.worktrees.remove).not.toHaveBeenCalled()
        expect(store.getState().worktreesByRepo.repo1).toEqual([wt])
      } else {
        expect(result).toEqual({ ok: true })
        expect(mockApi.worktrees.remove).toHaveBeenCalledWith(
          expect.objectContaining({
            removeHookHash: '4a299b459fdefa259987e40b38e523e3a69ed42ec789f26f7a652d48d7eb8316',
            skipArchive: true
          })
        )
      }
    }
  )
})
