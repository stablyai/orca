// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { EditorPathMutationTarget } from '@/components/editor/editor-autosave'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client'

const mocks = vi.hoisted(() => {
  const focus: { value: string | null } = { value: null }
  return {
    focus,
    quiesce: vi.fn<(target: EditorPathMutationTarget) => Promise<void>>(),
    notify: vi.fn<(target: EditorPathMutationTarget) => void>(),
    discard: vi.fn(),
    bulkDiscard: vi.fn()
  }
})
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))
vi.mock('@/components/editor/editor-autosave', () => ({
  requestEditorSaveQuiesce: mocks.quiesce,
  notifyEditorExternalFileChange: mocks.notify
}))
vi.mock('@/runtime/runtime-git-client', () => ({
  discardRuntimeGitPath: mocks.discard,
  bulkDiscardRuntimeGitPaths: mocks.bulkDiscard,
  stageRuntimeGitPath: vi.fn(),
  unstageRuntimeGitPath: vi.fn(),
  bulkUnstageRuntimeGitPaths: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ settings: { activeRuntimeEnvironmentId: mocks.focus.value } })
  })
}))
import { useSourceControlEntryMutations } from './use-entry-mutations'

beforeEach(() => vi.clearAllMocks())

for (const bulk of [false, true]) {
  it.each([
    { name: 'managed repo with local focus', owner: 'host-a', focus: null },
    { name: 'managed repo with another host focused', owner: 'host-a', focus: 'host-b' },
    { name: 'desktop repo with remote focus', owner: null, focus: 'host-b' }
  ])(
    `${bulk ? 'bulk' : 'single'} discard waits for the $name editor saves`,
    async ({ owner, focus }) => {
      mocks.focus.value = focus
      let release: () => void = () => {}
      const pendingSave = new Promise<void>((resolve) => {
        release = resolve
      })
      mocks.quiesce.mockImplementation((target) =>
        target.runtimeEnvironmentId === owner ? pendingSave : Promise.resolve()
      )
      const activeRepoSettings: RuntimeGitContext['settings'] = {
        activeRuntimeEnvironmentId: owner
      }
      const { result } = renderHook(() =>
        useSourceControlEntryMutations({
          activeRepoSettings,
          activeWorktreeId: 'wt-owner',
          worktreePath: '/repo',
          refreshActiveGitStatusAfterMutation: async () => {}
        })
      )
      const paths = bulk ? ['first.txt', 'second.txt'] : ['first.txt']
      let discarded: Promise<void> = Promise.resolve()
      await act(async () => {
        discarded = bulk
          ? result.current.discardMany(paths)
          : result.current.discardSingle(paths[0])
        await Promise.resolve()
        await Promise.resolve()
      })
      const invokedBeforeSaveFinished = (bulk ? mocks.bulkDiscard : mocks.discard).mock.calls.length
      release()
      await act(async () => {
        await discarded
      })
      expect(invokedBeforeSaveFinished).toBe(0)
      expect(mocks.quiesce.mock.calls.map(([target]) => target)).toEqual(
        paths.map((relativePath) => ({
          worktreeId: 'wt-owner',
          worktreePath: '/repo',
          relativePath,
          runtimeEnvironmentId: owner
        }))
      )
      expect(mocks.notify.mock.calls.map(([target]) => target)).toEqual(
        paths.map((relativePath) => ({
          worktreeId: 'wt-owner',
          worktreePath: '/repo',
          relativePath,
          runtimeEnvironmentId: owner
        }))
      )
      const mutation = bulk ? mocks.bulkDiscard : mocks.discard
      expect(mutation).toHaveBeenCalledTimes(1)
      expect(mutation.mock.calls[0]?.[0]).toMatchObject({ settings: activeRepoSettings })
    }
  )
}
