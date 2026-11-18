import { describe, expect, it, vi } from 'vitest'
import { openFileInBrowserTab } from './file-preview'

const createBrowserTab = vi.hoisted(() => vi.fn())

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => ({ createBrowserTab }) } }))
vi.mock('@/lib/workspace/creation/surface-policy/client-creation-action-policy', () => ({
  getWorkspaceClientCreationActionPolicy: () => ({ 'managed-browser': { state: 'enabled' } })
}))
vi.mock('@/lib/workspace/ownership/resolve-owner', () => ({ isTwinWorkspace: () => false }))
vi.mock('@/lib/workspace/ownership/connection-owner-resolution', () => ({
  getConnectionIdForFileFromState: () => null
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))

describe('openFileInBrowserTab', () => {
  it('opens a local page in the placement workspace, like a document preview does', () => {
    openFileInBrowserTab({
      filePath: '/repo/site/index.html',
      worktreeId: 'repo-wt',
      placementWorkspaceId: 'folder-1'
    })
    expect(createBrowserTab).toHaveBeenCalledWith(
      'folder-1',
      'file:///repo/site/index.html',
      expect.objectContaining({ title: 'index.html', activate: true })
    )
  })
})
