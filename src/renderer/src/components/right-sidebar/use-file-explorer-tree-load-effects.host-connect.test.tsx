// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => {
  const host: { connectedEpoch: string | null } = { connectedEpoch: null }
  return host
})

vi.mock('@/lib/worktree-host-connection-phase', () => ({
  useWorktreeHostConnection: () => ({ connectedEpoch: mocks.connectedEpoch })
}))

import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'

const WORKTREE_PATH = '/home/me/repo'

function renderLoadEffects(rootError: string | null, worktreeId = 'wt-remote') {
  const resetAndLoad = vi.fn()
  const hook = renderHook(
    ({ worktreeId: id }: { worktreeId: string }) =>
      useFileExplorerTreeLoadEffects({
        worktreeId: id,
        visibleFilesWorktreePath: WORKTREE_PATH,
        expanded: new Set(),
        dirCache: {},
        loadingDirPaths: new Set(),
        rootError,
        isDirStale: () => false,
        loadDir: vi.fn(async () => true),
        resetAndLoad,
        resetSelection: vi.fn(),
        setNameFilterQuery: vi.fn()
      }),
    { initialProps: { worktreeId } }
  )
  // Why: the first mount resets and loads the newly visible tree; only later loads matter here.
  resetAndLoad.mockClear()
  return { ...hook, resetAndLoad }
}

describe('file explorer tree reload when its host connects', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    mocks.connectedEpoch = null
  })

  it('reloads a failed tree when a host a remote runtime owns connects', () => {
    const { rerender, resetAndLoad } = renderLoadEffects('read failed')

    // The runtime's mirrored state moves; this client's own SSH generation does not.
    mocks.connectedEpoch = 'ssh-a:1'
    rerender({ worktreeId: 'wt-remote' })

    expect(resetAndLoad).toHaveBeenCalledTimes(1)
  })

  it('leaves a healthy tree alone when its host connects', () => {
    const { rerender, resetAndLoad } = renderLoadEffects(null)

    mocks.connectedEpoch = 'ssh-a:1'
    rerender({ worktreeId: 'wt-remote' })

    expect(resetAndLoad).not.toHaveBeenCalled()
  })

  it('does not read switching to a connected workspace as its host connecting', () => {
    const { rerender, resetAndLoad } = renderLoadEffects('read failed', 'wt-local')

    mocks.connectedEpoch = 'ssh-a:1'
    rerender({ worktreeId: 'wt-remote' })

    expect(resetAndLoad).not.toHaveBeenCalled()
  })
})
