import { commitPreparedLinkForRoutingTest } from '../terminal-pane/terminal-link-handlers-test-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewTerminalLinkContext as resolvePreviewTerminalLinkContext } from './preview-terminal-link-context'
import { terminalLinkClickBehaviorFor } from '@/components/terminal-pane/terminal-link-click-behavior'
import { handleOscLink } from '@/components/terminal-pane/terminal-osc-link-routing'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import type { TerminalLinkActionRequest } from '@/components/terminal-pane/terminal-link-action-request'
import type { FileOpenFailure } from '@/components/terminal-pane/terminal-file-open-routing'

const harness = vi.hoisted(() => {
  const state: { value: Record<string, unknown> } = { value: {} }
  const pane: { startupCwd: string; terminalHomePath: string | null } = {
    startupCwd: '/home/u/proj/package',
    terminalHomePath: '/home/u'
  }
  return {
    state,
    stat: vi.fn(async () => ({ isDirectory: false, size: 1, mtime: 0 })),
    rpc: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      isDirectory: false,
      size: 1,
      mtime: 0
    })),
    download: vi.fn(),
    startDownload: vi.fn(),
    appendDownload: vi.fn(),
    finishDownload: vi.fn(),
    cancelDownload: vi.fn(),
    openLocal: vi.fn(),
    unresolved: vi.fn(),
    open: vi.fn(() => null),
    reveal: vi.fn(),
    failure: vi.fn<(path: string, failure: FileOpenFailure) => void>(),
    pane,
    registered: true,
    ptyId: 'pty-1'
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => harness.state.value } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: harness.reveal,
  activateAndRevealWorktree: harness.reveal
}))
vi.mock('@/lib/file-link-open-failure-toast', () => ({
  showFileLinkOpenFailureToast: harness.failure
}))
vi.mock('@/components/native-chat/native-chat-file-link-toasts', () => ({
  showFileLinkUnresolvedToast: harness.unresolved
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: harness.rpc }))
vi.mock('@/components/terminal-pane/terminal-pane-wsl-distro', () => ({
  resolvePaneWslDistro: () => null
}))
vi.mock('@/lib/workspace-browser-route-eligibility', () => ({
  canOpenWorkspaceBrowserTabOnRuntime: () => false,
  canOpenWorkspaceBrowserTabOnSsh: () => false
}))
vi.mock('@/runtime/mounted-terminal-tab-registry', () => ({
  findRegisteredTerminalTab: () =>
    harness.registered
      ? {
          tab: {
            getManager: () => ({ getNumericIdForLeaf: () => 1 }),
            getPtyIdForPane: () => harness.ptyId,
            getLinkContextForPane: () => harness.pane
          }
        }
      : null
}))

function previewTerminalLinkContext(
  source: Parameters<typeof resolvePreviewTerminalLinkContext>[0]
) {
  return { ...resolvePreviewTerminalLinkContext(source), commit: commitPreparedLinkForRoutingTest }
}

const id = 'repo::/home/u/proj'
const path = '/home/u/proj'
function state(activeHost: string, proxied = false): Record<string, unknown> {
  return {
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: activeHost,
    settings: {},
    repos: [
      { id: 'repo', executionHostId: 'local' },
      { id: 'repo', executionHostId: 'ssh:box', connectionId: 'box' }
    ],
    worktreesByRepo: {
      repo: [
        { id, repoId: 'repo', path, hostId: 'local' },
        {
          id,
          repoId: 'repo',
          path,
          hostId: 'ssh:box',
          ...(proxied ? { runtimeOwnerEnvironmentId: 'hub' } : {})
        }
      ]
    },
    folderWorkspaces: [
      { id: 'folder', projectGroupId: 'g', folderPath: path, executionHostId: 'local' },
      {
        id: 'folder',
        projectGroupId: 'g',
        folderPath: path,
        executionHostId: 'ssh:box',
        connectionId: 'box'
      }
    ],
    projectGroups: [],
    openFiles: [],
    unifiedTabsByWorktree: {},
    openFileForLink: harness.open
  }
}
function source(executionHostId: 'local' | 'ssh:box', worktreeId = id) {
  return { executionHostId, worktreeId, tabId: 'tab', leafId: 'leaf', ptyId: 'pty-1' }
}
async function settle(): Promise<void> {
  // Drain the production stat/open chain without a wall-clock wait.
  for (let i = 0; i < 24; i++) {
    await Promise.resolve()
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  harness.stat.mockResolvedValue({ isDirectory: false, size: 1, mtime: 0 })
  harness.rpc.mockResolvedValue({ isDirectory: false, size: 1, mtime: 0 })
  harness.registered = true
  harness.ptyId = 'pty-1'
  harness.pane.startupCwd = '/home/u/proj/package'
  harness.pane.terminalHomePath = '/home/u'
  harness.state.value = state('local')
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  harness.startDownload.mockResolvedValue({ canceled: false, transferId: 'download-1' })
  harness.appendDownload.mockResolvedValue({ ok: true })
  harness.finishDownload.mockResolvedValue({
    canceled: false,
    destinationPath: '/downloads/config.ts'
  })
  vi.stubGlobal('window', {
    api: {
      fs: {
        stat: harness.stat,
        downloadFile: harness.download,
        startDownloadedFile: harness.startDownload,
        appendDownloadedFileChunk: harness.appendDownload,
        finishDownloadedFile: harness.finishDownload,
        cancelDownloadedFile: harness.cancelDownload
      },
      shell: { openFilePath: harness.openLocal }
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('preview source through OSC file opening', () => {
  it.each([
    ['local', 'ssh:box', 'box'],
    ['ssh:box', 'local', undefined]
  ] as const)(
    'keeps source %s selection separate from card %s for git and folder twins',
    async (active, card, connectionId) => {
      for (const workspaceId of [id, 'folder:folder']) {
        harness.state.value = { ...state(active), activeWorktreeId: workspaceId }
        const context = previewTerminalLinkContext(source(card, workspaceId))
        handleOscLink('file:///home/u/proj/config.ts', { metaKey: true, ctrlKey: false }, context)
        await settle()
        expect(harness.stat).toHaveBeenLastCalledWith(
          expect.objectContaining({ filePath: `${path}/config.ts`, connectionId })
        )
        expect(harness.reveal).toHaveBeenLastCalledWith(
          workspaceId,
          expect.objectContaining({ executionHostId: card })
        )
        expect(harness.open).toHaveBeenLastCalledWith(
          expect.objectContaining({ filePath: `${path}/config.ts`, worktreeId: workspaceId }),
          expect.anything(),
          null,
          expect.any(Function)
        )
      }
    }
  )

  it('keeps a chosen file action bound to its source after active host selection changes', async () => {
    const request = vi.fn<(request: TerminalLinkActionRequest) => void>()
    const context = previewTerminalLinkContext(source('ssh:box'))
    const onInternalOpen = vi.fn()
    handleOscLink(
      'file:///home/u/proj/config.ts',
      {
        metaKey: false,
        ctrlKey: false,
        type: 'contextmenu',
        button: 2,
        preventDefault: vi.fn()
      },
      {
        ...context,
        onInternalOpen,
        linkActionContext: {
          paneId: 0,
          pointerGesture: { canRequestAction: () => false, dispose: vi.fn() },
          commit: commitPreparedLinkForRoutingTest,
          request,
          focusTerminal: vi.fn(),
          sourceOwner: context.sourceOwner
        }
      }
    )
    expect(request).toHaveBeenCalledOnce()
    harness.state.value = state('local')
    request.mock.calls[0]?.[0].primary.run()
    await settle()
    expect(harness.stat).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'box' }))
    expect(onInternalOpen).toHaveBeenCalledOnce()
  })

  it('keeps the runtime transport and SSH place for a server-proxied source', async () => {
    harness.state.value = state('local', true)
    const context = previewTerminalLinkContext(source('ssh:box'))
    expect(context.fileContext).toMatchObject({
      target: { kind: 'environment', environmentId: 'hub' },
      connectionId: 'box',
      expectedExecutionHostId: 'ssh:box'
    })
    handleOscLink('file:///home/u/proj/config.ts', { metaKey: true, ctrlKey: false }, context)
    await settle()
    expect(harness.stat).not.toHaveBeenCalled()
    expect(harness.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'hub' },
      'files.stat',
      { worktree: `id:${id}`, relativePath: 'config.ts' },
      expect.anything()
    )
    expect(harness.reveal).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ executionHostId: 'ssh:box' })
    )
  })

  it.each(['modifier', 'menu'] as const)(
    'downloads the proxied SSH source through its owning transport via %s',
    async (activation) => {
      harness.state.value = state('local', true)
      harness.rpc.mockImplementation(async (_target, method) =>
        method === 'files.readChunk'
          ? { contentBase64: 'eA==', bytesRead: 1, eof: true }
          : { isDirectory: false, size: 1, mtime: 0 }
      )
      const context = previewTerminalLinkContext(source('ssh:box'))
      const request = vi.fn<(request: TerminalLinkActionRequest) => void>()
      handleOscLink(
        'file:///home/u/proj/config.ts',
        {
          metaKey: activation === 'modifier',
          ctrlKey: false,
          shiftKey: activation === 'modifier',
          type: activation === 'menu' ? 'contextmenu' : 'click',
          button: activation === 'menu' ? 2 : 0,
          preventDefault: vi.fn()
        },
        {
          ...context,
          linkActionContext: {
            paneId: 0,
            pointerGesture: { canRequestAction: () => false, dispose: vi.fn() },
            commit: commitPreparedLinkForRoutingTest,
            request,
            focusTerminal: vi.fn(),
            sourceOwner: context.sourceOwner
          }
        }
      )
      if (activation === 'menu') {
        expect(request).toHaveBeenCalledOnce()
        const alternate = request.mock.calls[0]?.[0].alternate
        expect(alternate?.label).toBe('Download & open with default app')
        alternate?.run()
      }
      await settle()
      expect(harness.rpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'hub' },
        'files.readChunk',
        expect.objectContaining({ worktree: `id:${id}`, relativePath: 'config.ts', offset: 0 }),
        expect.anything()
      )
      expect(harness.appendDownload).toHaveBeenCalledWith({
        transferId: 'download-1',
        contentBase64: 'eA=='
      })
      expect(harness.openLocal).toHaveBeenCalledExactlyOnceWith('/downloads/config.ts', 'local')
      expect(harness.download).not.toHaveBeenCalled()
      expect(harness.open).not.toHaveBeenCalled()
      expect(harness.reveal).not.toHaveBeenCalled()
    }
  )

  it('keeps ignored unresolved gestures silent and reports accepted preview/normal-pane actions once', () => {
    harness.registered = false
    const preview = previewTerminalLinkContext(source('ssh:box'))
    const sources = [
      { context: preview, target: 'src/main.ts:12', pathText: 'src/main.ts' },
      {
        context: { ...preview, startupCwd: '/workspace/package' },
        target: '~/note.ts',
        pathText: '~/note.ts'
      }
    ]
    const cases: {
      name: string
      settings?: Parameters<typeof terminalLinkClickBehaviorFor>[0]
      absent?: boolean
      pointer?: boolean
      claim?: boolean
      modifier?: boolean
      menu?: boolean
      allowed: boolean
      claims: number
    }[] = [
      {
        name: 'disabled',
        settings: { terminalLinkClickBehavior: 'none' },
        allowed: false,
        claims: 0
      },
      {
        name: 'legacy disabled',
        settings: { terminalLinkActionPopoverEnabled: false },
        allowed: false,
        claims: 0
      },
      { name: 'no requester', absent: true, allowed: false, claims: 0 },
      { name: 'selection/drag', pointer: false, allowed: false, claims: 0 },
      { name: 'claim denied', claim: false, allowed: false, claims: 1 },
      { name: 'plain actions', allowed: true, claims: 1 },
      {
        name: 'plain open',
        settings: { terminalLinkClickBehavior: 'open' },
        allowed: true,
        claims: 1
      },
      { name: 'modifier', absent: true, modifier: true, allowed: true, claims: 0 },
      {
        name: 'contextmenu disabled',
        settings: { terminalLinkClickBehavior: 'none' },
        menu: true,
        pointer: false,
        allowed: true,
        claims: 1
      },
      { name: 'contextmenu claim denied', menu: true, claim: false, allowed: false, claims: 1 }
    ]
    for (const { context, target, pathText } of sources) {
      for (const activation of cases) {
        harness.unresolved.mockClear()
        const pointer = vi.fn(() => activation.pointer !== false)
        const claim = vi.fn(() => activation.claim !== false)
        const request = vi.fn()
        const handled = handleOscLink(
          target,
          {
            metaKey: activation.modifier ?? false,
            ctrlKey: false,
            type: activation.menu ? 'contextmenu' : 'click',
            button: activation.menu ? 2 : 0,
            preventDefault: vi.fn()
          },
          {
            ...context,
            commit: activation.absent ? commitPreparedLinkForRoutingTest : undefined,
            linkActionContext: activation.absent
              ? null
              : {
                  paneId: 0,
                  pointerGesture: { canRequestAction: pointer, dispose: vi.fn() },
                  commit: (event, operation) =>
                    claim() && commitPreparedLinkForRoutingTest(event, operation),
                  request,
                  focusTerminal: vi.fn(),
                  plainClickBehavior: terminalLinkClickBehaviorFor(activation.settings)
                }
          }
        )
        expect(handled, activation.name).toBe(activation.allowed)
        expect(harness.unresolved.mock.calls, activation.name).toEqual(
          activation.allowed ? [[pathText]] : []
        )
        expect(request, activation.name).not.toHaveBeenCalled()
        expect(claim.mock.calls.length, activation.name).toBe(activation.claims)
      }
    }
    expect(harness.stat).not.toHaveBeenCalled()
    expect(harness.open).not.toHaveBeenCalled()
  })

  it.each(['absent', 'mismatched', 'missing-inputs'] as const)(
    'refuses unknown relative/home bases for %s sources while opening genuine absolute paths',
    async (availability) => {
      harness.registered = availability !== 'absent'
      harness.ptyId = availability === 'mismatched' ? 'other-pty' : 'pty-1'
      if (availability === 'missing-inputs') {
        harness.pane.startupCwd = ''
        harness.pane.terminalHomePath = null
      }
      // A persisted startup directory is not the cwd of the unavailable source process.
      harness.state.value = {
        ...state('local'),
        tabsByWorktree: { [id]: [{ id: 'tab', startupCwd: '/wrong' }] }
      }
      const context = previewTerminalLinkContext(source('ssh:box'))
      for (const target of ['src/main.ts:12', '~/note.ts']) {
        handleOscLink(target, { metaKey: true, ctrlKey: false }, context)
        await settle()
      }
      expect(harness.unresolved.mock.calls).toEqual([['src/main.ts'], ['~/note.ts']])
      expect(harness.stat).not.toHaveBeenCalled()
      expect(harness.open).not.toHaveBeenCalled()
      for (const target of ['/home/u/proj/config.ts', 'file:///home/u/proj/config.ts']) {
        handleOscLink(target, { metaKey: true, ctrlKey: false }, context)
        await settle()
        expect(harness.stat).toHaveBeenLastCalledWith(
          expect.objectContaining({ filePath: `${path}/config.ts`, connectionId: 'box' })
        )
      }
      expect(harness.open).toHaveBeenCalledTimes(2)
    }
  )

  it('uses known home without cwd and refuses unknown home outside an inferable home directory', async () => {
    harness.pane.startupCwd = ''
    handleOscLink(
      '~/note.ts',
      { metaKey: true, ctrlKey: false },
      previewTerminalLinkContext(source('ssh:box'))
    )
    await settle()
    expect(harness.stat).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/home/u/note.ts' })
    )
    harness.stat.mockClear()
    harness.pane.startupCwd = '/workspace/package'
    harness.pane.terminalHomePath = null
    const context = previewTerminalLinkContext(source('ssh:box'))
    handleOscLink('~/note.ts', { metaKey: true, ctrlKey: false }, context)
    await settle()
    expect(harness.unresolved).toHaveBeenCalledExactlyOnceWith('~/note.ts')
    expect(harness.stat).not.toHaveBeenCalled()
    handleOscLink('src/main.ts', { metaKey: true, ctrlKey: false }, context)
    await settle()
    expect(harness.stat).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/workspace/package/src/main.ts' })
    )
  })

  it.each(['src/main.ts:12', '~/note.ts'] as const)(
    'matches pane cwd/home resolution for %s',
    async (target) => {
      const context = previewTerminalLinkContext(source('ssh:box'))
      handleOscLink(target, { metaKey: true, ctrlKey: false }, context)
      await settle()
      const expected = target.startsWith('~') ? '/home/u/note.ts' : `${path}/package/src/main.ts`
      expect(harness.stat).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: expected, connectionId: 'box' })
      )
    }
  )

  it.each([
    ['ENOENT: missing', 'missing'],
    ['connection dropped', 'unverifiable']
  ] as const)('preserves existing file refusal feedback for %s', async (message, verdict) => {
    const error = new Error(message)
    harness.stat.mockRejectedValue(error)
    const context = previewTerminalLinkContext(source('ssh:box'))
    const onOpenFailure = vi.fn()
    openDetectedFilePath(`${path}/gone.ts`, null, null, { ...context, onOpenFailure })
    await settle()
    handleOscLink(`file://${path}/gone.ts`, { metaKey: true, ctrlKey: false }, context)
    await settle()
    expect(onOpenFailure).toHaveBeenCalledExactlyOnceWith({ verdict, error })
    expect(harness.failure).toHaveBeenCalledExactlyOnceWith(`${path}/gone.ts`, { verdict, error })
    expect(harness.open).not.toHaveBeenCalled()
    expect(harness.reveal).not.toHaveBeenCalled()
  })
})
