import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  /** What the per-file resolver answers: null local, a string remote, undefined unresolved. */
  connectionIdForFile: null as string | null | undefined,
  /** What the workspace-scoped resolver answers, which is not always the same thing. */
  connectionIdForWorkspace: null as string | null | undefined,
  worktreePath: '/srv/repo' as string | null,
  /** What the worktree resolves its runtime owner to, which the grant was minted against. */
  worktreeRuntimeOwnerId: null as string | null,
  activeRuntimeEnvironmentId: undefined as string | undefined,
  twin: false,
  openFile: vi.fn(),
  openFilePath: vi.fn().mockResolvedValue(true),
  downloadAndOpen: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, string>) =>
    fallback.replace('{{value0}}', params?.value0 ?? '')
}))

vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdForFileFromState: () => mocks.connectionIdForFile
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => mocks.worktreeRuntimeOwnerId
}))
vi.mock('@/lib/file-owner-runtime-target', () => {
  const getRuntimeTargetForFileOwner = (
    _state: unknown,
    _worktreeId: string | null | undefined,
    runtimeEnvironmentId: string | null | undefined
  ) => {
    const owner =
      runtimeEnvironmentId === undefined ? mocks.worktreeRuntimeOwnerId : runtimeEnvironmentId
    return owner
      ? { kind: 'environment' as const, environmentId: owner }
      : { kind: 'local' as const }
  }
  return {
    FILE_OWNER_UNRESOLVED_MESSAGE: 'unresolved',
    getRuntimeTargetForFileOwner,
    requireRuntimeTargetForFileOwner: getRuntimeTargetForFileOwner,
    getRuntimeTargetForWorktreeOwner: (state: unknown, worktreeId: string | null | undefined) =>
      getRuntimeTargetForFileOwner(state, worktreeId, undefined)
  }
})
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => mocks.connectionIdForWorkspace,
  getConnectionIdForFile: () => mocks.connectionIdForFile
}))
vi.mock('@/components/terminal-pane/terminal-remote-file-download-open', () => ({
  downloadAndOpenRemoteTerminalFile: mocks.downloadAndOpen
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {
        activeRuntimeEnvironmentId: mocks.activeRuntimeEnvironmentId
      },
      getKnownWorktreeById: () =>
        mocks.worktreePath === null ? undefined : { id: 'wt-1', path: mocks.worktreePath },
      ...(mocks.twin ? localAndSshTwinRows('repo', 'repo::/srv/repo') : {}),
      openFile: mocks.openFile
    })
  }
}))

import { openDocPreviewExternally, openDocPreviewSource } from './doc-preview-document-actions'
import { localAndSshTwinRows } from '@/lib/workspace-twin-rows.test-fixture'

const REMOTE_DOCUMENT = {
  filePath: '/root/demo/report/index.html',
  relativePath: 'report/index.html',
  worktreeId: 'wt-1',
  runtimeEnvironmentId: null,
  externalSshTargetId: null
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connectionIdForFile = null
  mocks.connectionIdForWorkspace = null
  mocks.worktreePath = '/srv/repo'
  mocks.worktreeRuntimeOwnerId = null
  mocks.activeRuntimeEnvironmentId = undefined
  mocks.twin = false
  mocks.openFilePath.mockResolvedValue(true)
  vi.stubGlobal('window', { api: { shell: { openFilePath: mocks.openFilePath } } })
})

describe('openDocPreviewSource', () => {
  it('opens the document as an ordinary source tab with the editor language', () => {
    openDocPreviewSource(REMOTE_DOCUMENT)

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: REMOTE_DOCUMENT.filePath,
        relativePath: REMOTE_DOCUMENT.relativePath,
        worktreeId: 'wt-1',
        language: 'html',
        mode: 'edit'
      })
    )
  })

  // An absolute path alone cannot distinguish an external SSH file from this computer’s file.
  it('carries the external SSH target onto the source tab', () => {
    openDocPreviewSource({ ...REMOTE_DOCUMENT, externalSshTargetId: 'ssh-7' })

    expect(mocks.openFile).toHaveBeenCalledWith(
      expect.objectContaining({ externalSshTargetId: 'ssh-7' })
    )
  })

  it('omits the field entirely when the document has no external target', () => {
    openDocPreviewSource(REMOTE_DOCUMENT)

    expect(mocks.openFile.mock.calls[0]?.[0]).not.toHaveProperty('externalSshTargetId')
  })
})

describe('openDocPreviewExternally', () => {
  it('hands a local document straight to the OS', () => {
    openDocPreviewExternally(REMOTE_DOCUMENT)

    expect(mocks.openFilePath).toHaveBeenCalledWith(REMOTE_DOCUMENT.filePath, 'local')
    expect(mocks.downloadAndOpen).not.toHaveBeenCalled()
  })

  it('downloads an SSH document before handing it over', () => {
    mocks.connectionIdForFile = 'ssh-1'
    mocks.connectionIdForWorkspace = 'ssh-1'

    openDocPreviewExternally(REMOTE_DOCUMENT)

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1' }),
      REMOTE_DOCUMENT.filePath
    )
  })

  // Folder workspaces may span hosts; unresolved workspace ownership must not override a resolved file owner.
  it('routes on the file owner when the workspace-scoped owner is unresolved', () => {
    mocks.connectionIdForFile = 'ssh-1'
    mocks.connectionIdForWorkspace = undefined

    openDocPreviewExternally(REMOTE_DOCUMENT)

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1' }),
      REMOTE_DOCUMENT.filePath
    )
  })

  // Unknown ownership must refuse: downloading could otherwise read an unrelated same-named local file.
  it("refuses a document of a project two hosts publish instead of opening this machine's copy", () => {
    mocks.twin = true

    openDocPreviewExternally({ ...REMOTE_DOCUMENT, worktreeId: 'repo::/srv/repo' })

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalled()
  })

  it('refuses instead of reading this machine when no owner resolves', () => {
    mocks.connectionIdForFile = undefined
    mocks.connectionIdForWorkspace = undefined

    openDocPreviewExternally(REMOTE_DOCUMENT)

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('report/index.html'))
  })

  // Vary only the root so other remote-owner fields cannot mask this independent OS-open guard.
  it('refuses a document whose workspace root is unknown even when nothing names another host', () => {
    mocks.worktreePath = null

    openDocPreviewExternally(REMOTE_DOCUMENT)

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalled()
  })

  // A torn-down runtime may leave only the tab’s recorded owner.
  it('falls back to the tab runtime owner when the worktree resolves none', () => {
    mocks.worktreeRuntimeOwnerId = null
    mocks.activeRuntimeEnvironmentId = 'env-9'

    openDocPreviewExternally({ ...REMOTE_DOCUMENT, runtimeEnvironmentId: 'env-9' })

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).toHaveBeenCalled()
  })

  // Restored tabs can lack the owner used to mint their grant; consult the resolved worktree owner before choosing OS-open.
  it('routes on the worktree runtime owner when the tab carries none', () => {
    mocks.worktreeRuntimeOwnerId = 'env-1'
    mocks.activeRuntimeEnvironmentId = 'env-1'

    openDocPreviewExternally({ ...REMOTE_DOCUMENT, runtimeEnvironmentId: null })

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).toHaveBeenCalled()
  })

  // Runtime containment needs the root; unknown roots must not misclassify remote paths as local.
  it('downloads a runtime document whose workspace root is unknown', () => {
    mocks.worktreePath = null
    mocks.worktreeRuntimeOwnerId = 'env-1'
    mocks.activeRuntimeEnvironmentId = 'env-1'

    openDocPreviewExternally({ ...REMOTE_DOCUMENT, runtimeEnvironmentId: 'env-1' })

    expect(mocks.openFilePath).not.toHaveBeenCalled()
    expect(mocks.downloadAndOpen).toHaveBeenCalled()
  })
})
