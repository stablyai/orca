// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscardAllDeps, DiscardAllResult, DiscardAllArea } from './discard-all-sequence'
import type { SourceControlToastTestOptions } from './source-control-toast-test-options'

type DiscardAllRunner = (
  area: DiscardAllArea,
  paths: readonly string[],
  deps: DiscardAllDeps
) => Promise<DiscardAllResult>

const mocks = vi.hoisted(() => ({
  toastError: vi.fn<(title: string, options?: SourceControlToastTestOptions) => void>(),
  runDiscardAllForArea: vi.fn<DiscardAllRunner>()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, dismiss: vi.fn() } }))

vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => undefined }))

vi.mock('@/runtime/runtime-git-client', () => ({ bulkUnstageRuntimeGitPaths: vi.fn() }))

vi.mock('./discard-all-sequence', () => ({
  getDiscardAllPaths: () => [],
  runDiscardAllForArea: (area: DiscardAllArea, paths: readonly string[], deps: DiscardAllDeps) =>
    mocks.runDiscardAllForArea(area, paths, deps)
}))

import { useSourceControlDiscardConfirmation } from './use-discard-confirmation'
import type { SourceControlEntryGroups } from '../listing/section-order'

const EMPTY_GROUPS: SourceControlEntryGroups = { unstaged: [], staged: [], untracked: [] }

function lastDescription(): string | undefined {
  return mocks.toastError.mock.lastCall?.[1]?.description
}

function renderDiscard() {
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
      discardSingle: async () => {},
      refreshActiveGitStatusAfterMutation: async () => {}
    })
  )
}

async function confirmDiscardOf(
  paths: string[],
  area: 'staged' | 'unstaged' = 'unstaged'
): Promise<void> {
  const { result } = renderDiscard()
  await act(async () => {
    result.current.requestDiscardPaths(area, paths)
  })
  await act(async () => {
    result.current.confirmPendingDiscard()
  })
}

const WRAPPED = "Error invoking remote method 'git:discard': Error: index.lock exists"

describe('discard-all failure descriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('unwraps the IPC transport noise on a partial failure, like the per-row toast does', async () => {
    mocks.runDiscardAllForArea.mockImplementation(async (_area, _paths, handlers) => {
      handlers.onError?.(new Error(WRAPPED))

      return { aborted: false, discarded: [], failed: ['a.ts'] }
    })

    await confirmDiscardOf(['a.ts'])

    expect(lastDescription()).toContain('index.lock exists')
    expect(lastDescription()).not.toContain('Error invoking remote method')
  })

  // Why 'staged': `aborted` is set only by the bulkUnstage pre-step, which runs for staged entries.
  it('unwraps it on the aborted-before-discard path too', async () => {
    mocks.runDiscardAllForArea.mockImplementation(async (_area, _paths, handlers) => {
      handlers.onError?.(new Error(WRAPPED))

      return { aborted: true, discarded: [], failed: [] }
    })

    await confirmDiscardOf(['a.ts'], 'staged')

    expect(lastDescription()).toBe('index.lock exists')
  })
})
