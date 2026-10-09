import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLinkActionContext } from './terminal-link-action-request'

const mocks = vi.hoisted(() => {
  const settings: { activeRuntimeEnvironmentId: string | null } = {
    activeRuntimeEnvironmentId: null
  }
  return {
    canOpenWithSystemDefault: true,
    downloadAndOpen: vi.fn(),
    openDetectedFilePath: vi.fn(),
    settings,
    worktreeRoot: false
  }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: mocks.settings }) }
}))

vi.mock('./terminal-file-open-routing', () => ({
  getTerminalFileContext: () => ({ sourceHostResolved: true }),
  mapTerminalFilePath: (filePath: string) => filePath,
  openDetectedFilePath: mocks.openDetectedFilePath,
  shouldOpenTerminalFileWithSystemDefault: () => mocks.canOpenWithSystemDefault,
  terminalLinkWslDistro: () => null
}))

vi.mock('./terminal-worktree-path-link', () => ({
  resolveKnownWorktreeRootPathLink: () => (mocks.worktreeRoot ? { id: 'wt-2' } : null)
}))

vi.mock('./terminal-remote-file-download-open', () => ({
  downloadAndOpenRemoteTerminalFile: mocks.downloadAndOpen
}))

import { handleTerminalFileLink } from './terminal-file-link-actions'

const deps = { worktreeId: 'wt-1', worktreePath: '/repo' }

function plainEvent(): MouseEvent {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    clientX: 12,
    clientY: 24,
    preventDefault: vi.fn()
  } as unknown as MouseEvent
}

function context(
  request: ReturnType<typeof vi.fn>,
  sourceOwner: TerminalLinkActionContext['sourceOwner'] = { kind: 'local' }
): TerminalLinkActionContext {
  return {
    paneId: 3,
    pointerGesture: { canRequestAction: () => true, dispose: vi.fn() },
    claimPtyMouse: vi.fn(() => true),
    request: request as TerminalLinkActionContext['request'],
    focusTerminal: vi.fn(),
    sourceOwner
  }
}

const shellApi = {
  openInFileManager: vi.fn(async () => ({ ok: true })),
  openFilePath: vi.fn(async () => true)
}
const fsApi = { stat: vi.fn() }

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  vi.stubGlobal('window', { api: { shell: shellApi, fs: fsApi } })
  mocks.canOpenWithSystemDefault = true
  mocks.settings = { activeRuntimeEnvironmentId: null }
  mocks.worktreeRoot = false
  vi.clearAllMocks()
})

afterEach(() => vi.unstubAllGlobals())

describe('terminal file link actions', () => {
  it('offers Orca and system-default actions for a local file', () => {
    const request = vi.fn()
    expect(
      handleTerminalFileLink('/repo/src/main.ts', 12, 4, plainEvent(), deps, context(request))
    ).toBe(true)

    const actionRequest = request.mock.calls[0][0]
    expect(actionRequest).toEqual(
      expect.objectContaining({
        destination: '/repo/src/main.ts',
        kind: 'file',
        primary: expect.objectContaining({ label: 'Open file' }),
        alternate: expect.objectContaining({ label: 'Open with default app' })
      })
    )
    actionRequest.primary.run()
    actionRequest.alternate.run()
    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(1, '/repo/src/main.ts', 12, 4, deps)
    expect(mocks.openDetectedFilePath).toHaveBeenNthCalledWith(2, '/repo/src/main.ts', 12, 4, {
      ...deps,
      openWithSystemDefault: true
    })
  })

  it('labels workspace switching and omits an impossible remote alternate', () => {
    mocks.worktreeRoot = true
    mocks.canOpenWithSystemDefault = false
    const request = vi.fn()
    handleTerminalFileLink('/repo', null, null, plainEvent(), deps, context(request))

    const actionRequest = request.mock.calls[0][0]
    expect(actionRequest).toEqual(
      expect.objectContaining({
        kind: 'workspace',
        primary: expect.objectContaining({ label: 'Switch workspace' })
      })
    )
    expect(actionRequest).not.toHaveProperty('alternate')
  })

  it('offers the same rows for a remote previewable file, downloading before the OS opens it', () => {
    mocks.canOpenWithSystemDefault = false
    const request = vi.fn()
    handleTerminalFileLink(
      '/repo/docs/report.html',
      null,
      null,
      plainEvent(),
      deps,
      context(request)
    )

    const actionRequest = request.mock.calls[0][0]
    expect(actionRequest.primary.label).toBe('Open file')
    expect(actionRequest.alternate.label).toBe('Download & open with default app')

    actionRequest.alternate.run()
    expect(mocks.downloadAndOpen).toHaveBeenCalledWith(
      { sourceHostResolved: true },
      '/repo/docs/report.html'
    )
    expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
  })

  it('keeps row parity between local and remote previewable files', () => {
    const localRequest = vi.fn()
    handleTerminalFileLink(
      '/repo/docs/report.html',
      null,
      null,
      plainEvent(),
      deps,
      context(localRequest)
    )
    mocks.canOpenWithSystemDefault = false
    const remoteRequest = vi.fn()
    handleTerminalFileLink(
      '/repo/docs/report.html',
      null,
      null,
      plainEvent(),
      deps,
      context(remoteRequest)
    )

    const rowCount = (call: { alternate?: unknown }): number => 1 + (call.alternate ? 1 : 0)
    expect(rowCount(remoteRequest.mock.calls[0][0])).toBe(rowCount(localRequest.mock.calls[0][0]))
  })

  // Why: a directory has nothing to hand the OS, and the download row would offer a transfer that
  // can only fail. The popover is built on hover, so the path shape decides rather than a stat.
  it('drops the remote download row for a path that announces itself as a directory', () => {
    mocks.canOpenWithSystemDefault = false
    const request = vi.fn()

    handleTerminalFileLink('/repo/docs/', null, null, plainEvent(), deps, context(request))

    expect(request.mock.calls[0][0]).not.toHaveProperty('alternate')
  })

  describe('reveal row', () => {
    const revealRow = (request: ReturnType<typeof vi.fn>) =>
      request.mock.calls[0][0].secondaryActions?.find(
        (action: { label: string }) => action.label === 'Reveal in Finder'
      )

    it('offers Reveal in Finder for a local file link and reveals it through the shared path', async () => {
      const request = vi.fn()
      handleTerminalFileLink('/repo/src/main.ts', 12, 4, plainEvent(), deps, context(request))

      const row = revealRow(request)
      // Marked external so the popover draws the same icon as every other Reveal item.
      expect(row).toMatchObject({ external: true })
      await row.run()
      expect(shellApi.openInFileManager).toHaveBeenCalledWith('/repo/src/main.ts')
      expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
    })

    // Why: a macOS .app or .xcodeproj is a folder; "Reveal" must select it, never launch it.
    it('selects a folder link in its parent instead of opening it', async () => {
      const request = vi.fn()
      handleTerminalFileLink(
        '/repo/build/Orca.app',
        null,
        null,
        plainEvent(),
        deps,
        context(request)
      )

      await revealRow(request).run()
      expect(shellApi.openInFileManager).toHaveBeenCalledWith('/repo/build/Orca.app')
      expect(shellApi.openFilePath).not.toHaveBeenCalled()
      expect(fsApi.stat).not.toHaveBeenCalled()
      expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
    })

    it('uses the platform file manager name', () => {
      vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' })
      const request = vi.fn()
      handleTerminalFileLink('C:\\repo\\a.ts', null, null, plainEvent(), deps, context(request))

      expect(request.mock.calls[0][0].secondaryActions).toEqual([
        expect.objectContaining({ label: 'Reveal in File Explorer' })
      ])
    })

    it('omits the row for a workspace-root link, which has its own Open in Finder row', () => {
      mocks.worktreeRoot = true
      const request = vi.fn()
      handleTerminalFileLink('/repo', null, null, plainEvent(), deps, context(request))

      const actionRequest = request.mock.calls[0][0]
      expect(actionRequest.alternate.label).toBe('Open in Finder')
      expect(actionRequest).not.toHaveProperty('secondaryActions')
    })

    it('omits the row for a file owned by an SSH or runtime host', () => {
      mocks.canOpenWithSystemDefault = false
      const request = vi.fn()
      handleTerminalFileLink('/repo/src/main.ts', null, null, plainEvent(), deps, context(request))

      expect(request.mock.calls[0][0]).not.toHaveProperty('secondaryActions')
    })

    it.each([
      ['an SSH host', { kind: 'ssh', connectionId: 'conn-1' }],
      ['a paired runtime', { kind: 'runtime', runtimeEnvironmentId: 'env-1' }],
      ['an unknown host', { kind: 'unknown' }],
      ['an unreported host', undefined]
    ] as const)('omits the row when the pane shell runs on %s', (_label, sourceOwner) => {
      const request = vi.fn()
      handleTerminalFileLink(
        '/repo/src/main.ts',
        null,
        null,
        plainEvent(),
        deps,
        // Why spread: a default parameter would turn an explicit undefined back into local.
        { ...context(request), sourceOwner }
      )

      expect(request.mock.calls[0][0]).not.toHaveProperty('secondaryActions')
    })

    it('omits the row while a remote runtime is focused, or for a runtime-owned link', () => {
      mocks.settings = { activeRuntimeEnvironmentId: 'env-1' }
      const focused = vi.fn()
      handleTerminalFileLink('/repo/src/main.ts', null, null, plainEvent(), deps, context(focused))
      expect(focused.mock.calls[0][0]).not.toHaveProperty('secondaryActions')

      mocks.settings = { activeRuntimeEnvironmentId: null }
      const owned = vi.fn()
      handleTerminalFileLink(
        '/repo/src/main.ts',
        null,
        null,
        plainEvent(),
        { ...deps, runtimeEnvironmentId: 'env-1' },
        context(owned)
      )
      expect(owned.mock.calls[0][0]).not.toHaveProperty('secondaryActions')
    })

    it('reveals nothing until the row is clicked', () => {
      const request = vi.fn()
      handleTerminalFileLink('/repo/src/main.ts', null, null, plainEvent(), deps, context(request))

      expect(shellApi.openInFileManager).not.toHaveBeenCalled()
      expect(fsApi.stat).not.toHaveBeenCalled()
    })
  })
})
