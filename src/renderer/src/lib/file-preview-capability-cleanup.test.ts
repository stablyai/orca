import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openFilePreviewToSide } from './file-preview'

const mocks = vi.hoisted(() => ({
  availability: {
    state: 'enabled' as const,
    provider: 'paired-runtime' as const
  } as { state: 'enabled'; provider: 'paired-runtime' } | { state: 'hidden'; reason: string },
  closeEmptyGroup: vi.fn(),
  createBrowserTab: vi.fn(),
  createEmptySplitGroup: vi.fn(() => 'preview-group'),
  createWebRuntimeSessionBrowserTab: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/lib/client-creation-action-policy', () => ({
  getClientCreationActionPolicy: () => ({ 'managed-browser': mocks.availability })
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null,
  getConnectionIdForFile: () => null
}))

vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdForFileFromState: () => null
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'runtime-1'
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: mocks.createWebRuntimeSessionBrowserTab
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      closeEmptyGroup: mocks.closeEmptyGroup,
      createBrowserTab: mocks.createBrowserTab,
      createEmptySplitGroup: mocks.createEmptySplitGroup,
      groupsByWorktree: {},
      layoutByWorktree: {},
      repos: [{ id: 'repo-1', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
    })
  }
}))

describe('paired HTML side-preview capability cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.availability = { state: 'enabled', provider: 'paired-runtime' }
    mocks.createWebRuntimeSessionBrowserTab.mockRejectedValue(new Error('capability changed'))
  })

  it('reports capability loss after preflight and removes the new split', async () => {
    openFilePreviewToSide({
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'source-group'
    })

    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Unable to open this file in Orca Browser.')
    )
    expect(mocks.closeEmptyGroup).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('reports known unavailability without creating a split', () => {
    mocks.availability = { state: 'hidden', reason: 'streaming unavailable' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'source-group'
    })

    expect(mocks.toastError).toHaveBeenCalledWith('streaming unavailable')
    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.closeEmptyGroup).not.toHaveBeenCalled()
    expect(mocks.createWebRuntimeSessionBrowserTab).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })
})
