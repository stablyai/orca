import { describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { openDetectedFilePath } from './terminal-link-handlers'
import * as filePreview from '@/lib/file-preview'
import { TERMINAL_ARTIFACT_IN_PLACE_MAX_BYTES } from '../../../../shared/runtime-file-contracts'

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

const findWorkspaceFileRouteMock = vi.hoisted(() => vi.fn(() => null as unknown))
vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: findWorkspaceFileRouteMock
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
        byteLength: 100,
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
        byteLength: 100,
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

  it('opens a file another workspace holds in the clicked workspace through a grant', async () => {
    hostAnswers({
      worktree: 'wt-feat',
      relativePath: null,
      absolutePath: '/repo/src/index.ts',
      exists: true,
      isDirectory: false,
      openTarget: {
        kind: 'absolute-file',
        byteLength: 100,
        provider: 'local',
        absolutePath: '/repo/src/index.ts',
        grantId: 'grant-main'
      }
    })

    openDetectedFilePath('/repo/src/index.ts', null, null, featureWorktree)
    await flushDoubleRaf()

    // Why: asking for the holding workspace is what switched the user away from the click.
    expect(runtimeEnvironmentCallMock).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCallMock.mock.calls[0]![0].params).not.toHaveProperty('crossWorkspace')
    expect(activateAndRevealWorkspace).not.toHaveBeenCalledWith('wt-main', expect.anything())
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/src/index.ts',
        relativePath: '/repo/src/index.ts',
        worktreeId: 'wt-feat',
        terminalArtifactGrantId: 'grant-main'
      }),
      expect.anything()
    )
    expect(openFileMock.mock.calls[0]![0]).not.toHaveProperty('readOnly')
  })

  it('opens a file too large for one grant reply in the workspace holding it', async () => {
    hostAnswers({
      worktree: 'wt-feat',
      relativePath: null,
      absolutePath: '/repo/package-lock.json',
      exists: true,
      isDirectory: false,
      openTarget: {
        kind: 'absolute-file',
        byteLength: TERMINAL_ARTIFACT_IN_PLACE_MAX_BYTES + 1,
        provider: 'local',
        absolutePath: '/repo/package-lock.json',
        grantId: 'grant-main'
      }
    })
    hostAnswers({
      worktree: 'wt-main',
      relativePath: 'package-lock.json',
      absolutePath: '/repo/package-lock.json',
      exists: true,
      isDirectory: false
    })

    openDetectedFilePath('/repo/package-lock.json', null, null, featureWorktree)
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock.mock.calls[1]![0].params).toMatchObject({
      crossWorkspace: true
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'package-lock.json', worktreeId: 'wt-main' }),
      expect.anything()
    )
  })

  it('opens in the holding workspace when the host refuses a grant here', async () => {
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: false,
      error: {
        code: 'runtime_error',
        message: "Files outside an SSH workspace can't be opened from another device yet."
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    hostAnswers({
      worktree: 'wt-main',
      relativePath: 'src/index.ts',
      absolutePath: '/repo/src/index.ts',
      exists: true,
      isDirectory: false
    })

    openDetectedFilePath('/repo/src/index.ts', null, null, featureWorktree)
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock.mock.calls[1]![0].params).toMatchObject({
      crossWorkspace: true
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'src/index.ts', worktreeId: 'wt-main' }),
      expect.anything()
    )
  })

  it('resolves a folder another workspace holds there, since hosts grant only files', async () => {
    hostAnswers({
      worktree: 'wt-feat',
      relativePath: null,
      absolutePath: '/repo/docs',
      exists: true,
      isDirectory: true
    })
    hostAnswers({
      worktree: 'wt-main',
      relativePath: 'docs',
      absolutePath: '/repo/docs',
      exists: true,
      isDirectory: true
    })
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/repo/docs', null, null, { ...featureWorktree, onOpenFailure })
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock.mock.calls[1]![0].params).toMatchObject({
      crossWorkspace: true
    })
    expect(onOpenFailure).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('waits once, not twice, when the host does not answer', async () => {
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: false,
      error: { code: 'runtime_timeout', message: 'timed out' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/repo/src/index.ts', null, null, { ...featureWorktree, onOpenFailure })
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock).toHaveBeenCalledTimes(1)
    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'unverifiable' }))
  })

  it("reports a missing file another workspace holds as missing, never this computer's copy", async () => {
    findWorkspaceFileRouteMock.mockReturnValueOnce({
      worktreeId: 'wt-main',
      relativePath: 'src/gone.ts',
      executionHostId: 'runtime:env-1'
    })
    hostAnswers({
      worktree: 'wt-feat',
      relativePath: null,
      absolutePath: '/repo/src/gone.ts',
      exists: false,
      isDirectory: false
    })
    hostAnswers({
      worktree: 'wt-main',
      relativePath: 'src/gone.ts',
      absolutePath: '/repo/src/gone.ts',
      exists: false,
      isDirectory: false
    })
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/repo/src/gone.ts', null, null, { ...featureWorktree, onOpenFailure })
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock.mock.calls[1]![0].params).toMatchObject({
      crossWorkspace: true
    })
    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'missing' }))
  })
})
