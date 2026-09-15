// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { SourceControlToastTestOptions } from './source-control-toast-test-options'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn<(title: string, options?: SourceControlToastTestOptions) => void>(),
  toastDismiss: vi.fn<(id: string) => void>(),
  stagePath: vi.fn(),
  unstagePath: vi.fn(),
  discardPath: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, dismiss: mocks.toastDismiss, message: vi.fn() }
}))

vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))

vi.mock('@/components/editor/editor-autosave', () => ({
  notifyEditorExternalFileChange: vi.fn(),
  requestEditorSaveQuiesce: vi.fn(async () => {})
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  stageRuntimeGitPath: (...args: unknown[]) => mocks.stagePath(...args),
  unstageRuntimeGitPath: (...args: unknown[]) => mocks.unstagePath(...args),
  discardRuntimeGitPath: (...args: unknown[]) => mocks.discardPath(...args),
  bulkDiscardRuntimeGitPaths: vi.fn(),
  bulkUnstageRuntimeGitPaths: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, {
    getState: () => ({ settings: { activeRuntimeEnvironmentId: null }, activeWorktreeId: 'wt-1' })
  })
}))

import { useSourceControlDiscardConfirmation } from './use-discard-confirmation'
import { useSourceControlEntryMutations } from './use-entry-mutations'
import type { SourceControlEntryGroups } from '../listing/section-order'

const EMPTY_GROUPS: SourceControlEntryGroups = { unstaged: [], staged: [], untracked: [] }

function entry(
  path: string,
  status: GitStatusEntry['status'] = 'modified',
  area: GitStatusEntry['area'] = 'unstaged'
): GitStatusEntry {
  return { path, status, area }
}

function lastToast(): { title: string; options: SourceControlToastTestOptions } {
  const [title = '', options = {}] = mocks.toastError.mock.lastCall ?? []

  return { title, options }
}

function clickRetry(): void {
  lastToast().options.action?.onClick({ preventDefault: () => {} })
}

function renderMutations() {
  return renderHook(() =>
    useSourceControlEntryMutations({
      activeRepoSettings: null,
      activeWorktreeId: 'wt-1',
      worktreePath: '/repo',
      refreshActiveGitStatusAfterMutation: async () => {}
    })
  )
}

function renderDiscard(discardSingle: (path: string) => Promise<void>) {
  return renderHook(() =>
    useSourceControlDiscardConfirmation({
      activeRepoSettings: null,
      activeWorktreeId: 'wt-1',
      worktreePath: '/repo',
      grouped: EMPTY_GROUPS,
      isExecutingBulk: false,
      setIsExecutingBulk: () => {},
      clearSelection: () => {},
      discardMany: async () => {},
      discardSingle,
      refreshActiveGitStatusAfterMutation: async () => {}
    })
  )
}

describe('source-control entry mutation failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('reports a failed stage instead of leaving the row unchanged and silent', async () => {
    mocks.stagePath.mockRejectedValue(new Error('index.lock exists'))
    const { result } = renderMutations()

    await act(async () => {
      await result.current.handleStage('src/app.ts')
    })

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(lastToast().title).toBe('Failed to stage “src/app.ts”')
    expect(lastToast().options.description).toBe('index.lock exists')
  })

  it('retries the same path from the stage failure toast', async () => {
    mocks.stagePath.mockRejectedValueOnce(new Error('index.lock exists'))
    mocks.stagePath.mockResolvedValueOnce(undefined)
    const { result } = renderMutations()

    await act(async () => {
      await result.current.handleStage('src/app.ts')
    })
    await act(async () => {
      clickRetry()
    })

    expect(mocks.stagePath).toHaveBeenCalledTimes(2)
    expect(mocks.stagePath.mock.calls[1]?.[1]).toBe('src/app.ts')
    // Why: the retry succeeded, so no second failure toast — and the first one is cleared.
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastDismiss).toHaveBeenCalledWith('source-control-entry-mutation')
  })

  it('re-raises the failure toast when the retry fails again', async () => {
    // Why: sonner removes an action-clicked toast by id ~200ms later, so a fast re-failure could be
    // swallowed; the toast must survive the retry and show the second error.
    mocks.stagePath.mockRejectedValueOnce(new Error('index.lock exists'))
    mocks.stagePath.mockRejectedValueOnce(new Error('still locked'))
    const { result } = renderMutations()

    await act(async () => {
      await result.current.handleStage('src/app.ts')
    })
    await act(async () => {
      clickRetry()
    })

    expect(mocks.toastError).toHaveBeenCalledTimes(2)
    expect(lastToast().options.id).toBe('source-control-entry-mutation')
    expect(lastToast().options.description).toBe('still locked')
    expect(mocks.toastDismiss).not.toHaveBeenCalled()
  })

  it('reports a failed unstage', async () => {
    mocks.unstagePath.mockRejectedValue(new Error('bad object'))
    const { result } = renderMutations()

    await act(async () => {
      await result.current.handleUnstage('src/app.ts')
    })

    expect(lastToast().title).toBe('Failed to unstage “src/app.ts”')
  })

  it('leaves a successful stage silent, and clears a stale failure it supersedes', async () => {
    mocks.stagePath.mockRejectedValueOnce(new Error('index.lock exists'))
    mocks.stagePath.mockResolvedValueOnce(undefined)
    const { result } = renderMutations()

    await act(async () => {
      await result.current.handleStage('src/app.ts')
    })
    mocks.toastError.mockClear()
    await act(async () => {
      await result.current.handleStage('src/other.ts')
    })

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastDismiss).toHaveBeenCalledWith('source-control-entry-mutation')
  })

  it('reports a failed per-row discard — the destructive action must never fail silently', async () => {
    const discardSingle = vi.fn(async () => {
      throw new Error('unable to write file')
    })

    const { result } = renderDiscard(discardSingle)

    await act(async () => {
      result.current.requestDiscardEntry(entry('src/app.ts'))
    })
    await act(async () => {
      result.current.confirmPendingDiscard()
    })

    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(lastToast().title).toBe('Failed to discard “src/app.ts”')
    expect(lastToast().options.description).toBe('unable to write file')
  })

  it('does not put a destructive retry in the failure toast', async () => {
    const discardSingle = vi.fn(async () => {
      throw new Error('unable to write file')
    })

    const { result } = renderDiscard(discardSingle)

    await act(async () => {
      result.current.requestDiscardEntry(entry('src/app.ts'))
    })
    await act(async () => {
      result.current.confirmPendingDiscard()
    })
    expect(lastToast().options.action).toBeUndefined()
    expect(discardSingle).toHaveBeenCalledTimes(1)
  })

  it('says "delete" when the failed discard would have removed an untracked file', async () => {
    const discardSingle = vi
      .fn<(path: string) => Promise<void>>()
      .mockRejectedValue(new Error('unable to write file'))

    const { result } = renderDiscard(discardSingle)

    await act(async () => {
      result.current.requestDiscardEntry(entry('new.ts', 'untracked', 'untracked'))
    })
    await act(async () => {
      result.current.confirmPendingDiscard()
    })

    expect(lastToast().title).toBe('Failed to delete “new.ts”')
  })
})
