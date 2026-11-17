import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sourceControlFileOpenActions,
  sourceControlRouting
} from './source-control-file-open-actions'
import type { SourceControlScopeRouting } from '../panel/worktree-scope'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'

const mocks = vi.hoisted(() => ({
  openFileInBrowserTab: vi.fn(),
  openMarkdownPreview: vi.fn(),
  runtimeOwner: vi.fn()
}))

vi.mock('@/lib/browser/documents/file-preview', () => ({
  openFileInBrowserTab: mocks.openFileInBrowserTab
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ openMarkdownPreview: mocks.openMarkdownPreview }) }
}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: mocks.runtimeOwner
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

function scope(
  executionHostId: ExecutionHostId,
  placementWorkspaceId = 'repo-wt'
): SourceControlScopeRouting {
  return {
    worktreeId: 'repo-wt',
    repoId: 'repo',
    executionHostId,
    placementWorkspaceId,
    connectionId: null,
    runtimeOwnerEnvironmentId: undefined
  }
}

describe('Source Control row open actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openFileInBrowserTab.mockReturnValue({ status: 'browser-tab' })
    mocks.runtimeOwner.mockReturnValue(null)
  })

  it('opens an attached repo on its host and lands in the folder workspace pane', () => {
    const actions = sourceControlFileOpenActions(
      sourceControlRouting(scope('ssh:build-box', 'folder-1'))
    )
    actions.openInOrcaBrowser('repo-wt', '/repo/site/index.html')
    actions.openMarkdownPreviewFile('repo-wt', '/repo/README.md', 'README.md')

    expect(mocks.openFileInBrowserTab).toHaveBeenCalledWith({
      filePath: '/repo/site/index.html',
      worktreeId: 'repo-wt',
      refreshReusedPage: true,
      placementWorkspaceId: 'folder-1',
      fileExecutionHostId: 'ssh:build-box'
    })
    expect(mocks.openMarkdownPreview).toHaveBeenCalledWith(
      {
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        worktreeId: 'repo-wt',
        runtimeEnvironmentId: null,
        language: 'markdown'
      },
      { placementWorkspaceId: 'folder-1' }
    )
  })

  it('previews Markdown through a runtime host owner in its own pane', () => {
    sourceControlFileOpenActions(
      sourceControlRouting(scope('runtime:env-1'))
    ).openMarkdownPreviewFile('repo-wt', '/repo/README.md', 'README.md')
    expect(mocks.openMarkdownPreview.mock.calls[0]?.[0]).toMatchObject({
      runtimeEnvironmentId: 'env-1'
    })
  })

  it('passes an explicit local owner outside a folder section, never the active runtime', () => {
    sourceControlFileOpenActions(sourceControlRouting(null)).openMarkdownPreviewFile(
      'repo-wt',
      '/repo/README.md',
      'README.md'
    )
    expect(mocks.openMarkdownPreview).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeEnvironmentId: null }),
      undefined
    )
  })
})
