import { describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { openDetectedFilePath } from './terminal-link-handlers'
import * as filePreview from '@/lib/file-preview'
import {
  SSH_OUTSIDE_WORKSPACE_UNSUPPORTED_MESSAGE,
  TERMINAL_ARTIFACT_IN_PLACE_MAX_BYTES
} from '../../../../shared/runtime-file-contracts'

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

describe('a paired-server link to a file another workspace holds', () => {
  const FILE = '/repo/src/index.ts'

  function holderAnswers(): void {
    hostAnswers({
      worktree: 'wt-main',
      relativePath: 'src/index.ts',
      absolutePath: FILE,
      exists: true,
      isDirectory: false
    })
  }

  function grantAnswers(extra: { byteLength: number; binary?: true }): void {
    hostAnswers({
      worktree: 'wt-feat',
      relativePath: null,
      absolutePath: FILE,
      exists: true,
      isDirectory: false,
      openTarget: {
        kind: 'absolute-file',
        provider: 'local',
        absolutePath: FILE,
        grantId: 'grant-here',
        ...extra
      }
    })
  }

  function hostRefuses(message: string): void {
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: false,
      error: { code: 'runtime_error', message },
      _meta: { runtimeId: 'remote-runtime' }
    })
  }

  function expectOpenedIn(worktreeId: string, fields: Record<string, unknown> = {}): void {
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: FILE, worktreeId, ...fields }),
      expect.anything()
    )
  }

  it('opens it in the clicked workspace through a grant', async () => {
    holderAnswers()
    grantAnswers({ byteLength: 100 })

    openDetectedFilePath(FILE, null, null, featureWorktree)
    await flushDoubleRaf()

    // Why: the holder answers first, so every other path resolves exactly as before.
    expect(runtimeEnvironmentCallMock.mock.calls[0]![0].params).toMatchObject({
      crossWorkspace: true
    })
    expect(runtimeEnvironmentCallMock.mock.calls[1]![0].params).not.toHaveProperty('crossWorkspace')
    expect(activateAndRevealWorkspace).not.toHaveBeenCalledWith('wt-main', expect.anything())
    expectOpenedIn('wt-feat', { relativePath: FILE, terminalArtifactGrantId: 'grant-here' })
    expect(openFileMock.mock.calls[0]![0]).not.toHaveProperty('readOnly')
  })

  it.each([
    [
      'too large to edit through a grant',
      () => grantAnswers({ byteLength: TERMINAL_ARTIFACT_IN_PLACE_MAX_BYTES + 1 })
    ],
    [
      'binary, which its bytes editors read from the workspace',
      () => grantAnswers({ byteLength: 100, binary: true })
    ],
    [
      'outside what an SSH workspace can grant',
      () => hostRefuses(SSH_OUTSIDE_WORKSPACE_UNSUPPORTED_MESSAGE)
    ]
  ])('opens it in the holding workspace when it is %s', async (_label, answerHere) => {
    holderAnswers()
    answerHere()

    openDetectedFilePath(FILE, null, null, featureWorktree)
    await flushDoubleRaf()

    expectOpenedIn('wt-main', { relativePath: 'src/index.ts' })
  })

  it('surfaces any other host failure instead of switching workspaces', async () => {
    holderAnswers()
    hostRefuses('EIO: i/o error')
    const onOpenFailure = vi.fn()

    openDetectedFilePath(FILE, null, null, { ...featureWorktree, onOpenFailure })
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock).toHaveBeenCalledTimes(2)
    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledTimes(1)
  })
})
