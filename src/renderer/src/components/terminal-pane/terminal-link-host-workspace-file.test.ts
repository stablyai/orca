import { describe, expect, it, vi } from 'vitest'
import { openDetectedFilePath } from './terminal-link-handlers'
import * as filePreview from '@/lib/file-preview'

import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  flushDoubleRaf,
  installTerminalLinkTestEnvironment
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, openFileMock, openFilePathMock, runtimeEnvironmentCallMock } = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('./terminal-remote-file-download-open', () => ({
  downloadAndOpenRemoteTerminalFile: vi.fn()
}))

installTerminalLinkTestEnvironment(doubles)

const featureWorktree = {
  worktreeId: 'wt-feat',
  worktreePath: '/repo/.orca/worktrees/feat-x',
  runtimeEnvironmentId: 'env-1'
}

function hostAnswers(result: unknown): void {
  runtimeEnvironmentCallMock.mockResolvedValueOnce({
    id: 'rpc-1',
    ok: true,
    result,
    _meta: { runtimeId: 'remote-runtime' }
  })
}

describe('a paired-server link outside its own workspace', () => {
  it('opens granted HTML outside every registered workspace as a preview', async () => {
    hostAnswers({
      worktree: 'wt-feat',
      relativePath: null,
      absolutePath: '/tmp/report.html',
      exists: true,
      isDirectory: false,
      openTarget: {
        kind: 'absolute-file',
        provider: 'local',
        absolutePath: '/tmp/report.html',
        grantId: 'file-grant'
      }
    })
    const plan = { status: 'doc-preview' } as const
    const previewPlan = vi
      .spyOn(filePreview, 'getWorkspaceFilePreviewPlan')
      .mockReturnValueOnce(plan)
    const openPreview = vi.spyOn(filePreview, 'openFileInBrowserTab').mockReturnValueOnce(plan)
    try {
      openDetectedFilePath('/tmp/report.html', null, null, featureWorktree)
      await flushDoubleRaf()

      expect(openPreview).toHaveBeenCalledWith({
        filePath: '/tmp/report.html',
        worktreeId: 'wt-feat'
      })
      expect(openFileMock).not.toHaveBeenCalled()
      expect(openFilePathMock).not.toHaveBeenCalled()
      expect(downloadAndOpenRemoteTerminalFile).not.toHaveBeenCalled()
    } finally {
      previewPlan.mockRestore()
      openPreview.mockRestore()
    }
  })

  it('keeps HTML from a host that cannot re-grant it in the editor', async () => {
    hostAnswers({
      worktree: 'wt-feat',
      relativePath: null,
      absolutePath: '/tmp/report.html',
      exists: true,
      isDirectory: false,
      openTarget: {
        kind: 'absolute-file',
        provider: 'local',
        absolutePath: '/tmp/report.html',
        grantId: 'file-grant',
        readOnly: true
      }
    })
    const previewPlan = vi
      .spyOn(filePreview, 'getWorkspaceFilePreviewPlan')
      .mockReturnValue({ status: 'doc-preview' })
    const openPreview = vi.spyOn(filePreview, 'openFileInBrowserTab')
    try {
      openDetectedFilePath('/tmp/report.html', null, null, featureWorktree)
      await flushDoubleRaf()

      expect(openPreview).not.toHaveBeenCalled()
      expect(openFileMock).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/tmp/report.html',
          terminalArtifactGrantId: 'file-grant',
          readOnly: true
        }),
        expect.anything()
      )
    } finally {
      previewPlan.mockRestore()
      openPreview.mockRestore()
    }
  })

  it('retains the host-resolved HTML owner when opening in another workspace', async () => {
    storeState.unifiedTabsByWorktree = {
      'wt-feat': [
        {
          id: 'source',
          entityId: 'term-1',
          groupId: 'source-group',
          contentType: 'terminal',
          executionHostId: 'runtime:env-1'
        }
      ]
    }
    hostAnswers({
      worktree: 'wt-main',
      relativePath: 'report.html',
      absolutePath: '/repo/report.html',
      exists: true,
      isDirectory: false
    })
    const plan = { status: 'doc-preview' } as const
    const previewPlan = vi
      .spyOn(filePreview, 'getWorkspaceFilePreviewPlan')
      .mockReturnValueOnce(plan)
    const openPreview = vi.spyOn(filePreview, 'openFileInBrowserTab').mockReturnValueOnce(plan)
    try {
      openDetectedFilePath('/repo/report.html', null, null, {
        ...featureWorktree,
        sourceTabId: 'source'
      })
      await flushDoubleRaf()

      expect(openPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/repo/report.html',
          worktreeId: 'wt-main',
          fileExecutionHostId: 'runtime:env-1',
          linkContext: expect.objectContaining({
            linkIntent: expect.objectContaining({ workspaceId: 'wt-feat', hostId: 'runtime:env-1' })
          })
        })
      )
    } finally {
      previewPlan.mockRestore()
      openPreview.mockRestore()
    }
  })

  it('downloads a Shift-clicked host file instead of opening the same path on this computer', async () => {
    hostAnswers({
      worktree: 'wt-main',
      relativePath: 'src/index.ts',
      absolutePath: '/repo/src/index.ts',
      exists: true,
      isDirectory: false
    })

    openDetectedFilePath('/repo/src/index.ts', null, null, {
      ...featureWorktree,
      openWithSystemDefault: true
    })
    await flushDoubleRaf()

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(downloadAndOpenRemoteTerminalFile).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-main', worktreePath: '/repo' }),
      '/repo/src/index.ts'
    )
  })

  it('never opens a host directory on this computer', async () => {
    hostAnswers({
      worktree: 'wt-main',
      relativePath: 'docs',
      absolutePath: '/repo/docs',
      exists: true,
      isDirectory: true
    })

    openDetectedFilePath('/repo/docs', null, null, featureWorktree)
    await flushDoubleRaf()

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('reports a sibling-workspace file the host verified absent as missing', async () => {
    hostAnswers({
      worktree: 'wt-y',
      relativePath: 'src/gone.ts',
      absolutePath: '/repo/.orca/worktrees/feat-y/src/gone.ts',
      exists: false,
      isDirectory: false
    })
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/repo/.orca/worktrees/feat-y/src/gone.ts', null, null, {
      ...featureWorktree,
      onOpenFailure
    })
    await flushDoubleRaf()

    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'missing' }))
  })
})
