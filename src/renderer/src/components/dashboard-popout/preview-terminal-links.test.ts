// @vitest-environment happy-dom
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPreviewTerminalLinks } from './preview-terminal-links'
import { createTerminalLinkTestDoubles } from '../terminal-pane/terminal-link-handlers-test-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from '../terminal-pane/terminal-link-handlers-test-harness'
import { makeBufferLine } from '../terminal-pane/terminal-link-provider-buffer-fixtures'
import { getConnectionId } from '@/lib/connection-context'
import { registerWorkspaceHttpLinkBrowserOpener } from '@/lib/http-link-routing'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { PreviewTerminalWorkspace } from './agent-terminal-preview-props'

const hostState = vi.hoisted((): { value: ExecutionHostId } => ({ value: 'local' }))
const webCallbacks = vi.hoisted((): ((event: MouseEvent, uri: string) => void)[] => [])
const doubles = createTerminalLinkTestDoubles()
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...doubles.storeState,
      getKnownWorktreeById: (id: string) => (id === 'wt-1' ? { path: '/repo' } : undefined)
    })
  }
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => hostState.value
}))
vi.mock('../terminal-pane/terminal-pane-wsl-distro', () => ({ resolvePaneWslDistro: () => null }))
vi.mock('@/lib/workspace-browser-tab-open', () => ({
  canOpenWorkspaceBrowserTabOnRuntime: () => true,
  canOpenWorkspaceBrowserTabOnSsh: () => true
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (path: string) => (path.endsWith('.md') ? 'markdown' : 'plaintext')
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120
    options: { linkHandler?: unknown } = {}
    element = document.createElement('div')
    buffer = {
      active: {
        getLine: (row: number) => (row === 0 ? makeBufferLine('docs/guide.md:12:4') : undefined)
      }
    }
    clearSelection = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn()
    parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose = vi.fn()
    constructor(callback: (event: MouseEvent, uri: string) => void) {
      webCallbacks.push(callback)
    }
  }
}))
installTerminalLinkTestEnvironment(doubles)
beforeEach(() => {
  hostState.value = 'local'
  webCallbacks.length = 0
})
afterEach(() => {
  document.body.replaceChildren()
  registerWorkspaceHttpLinkBrowserOpener(null)
})

const workspace: PreviewTerminalWorkspace = {
  worktreeId: 'wt-1',
  tabId: 'tab-1',
  paneKey: null,
  cwd: '/repo/subdir',
  executionHostId: 'local'
}
function setup(overrides: Partial<PreviewTerminalWorkspace> = {}) {
  const terminal = new Terminal()
  const providers: ILinkProvider[] = []
  vi.spyOn(terminal, 'registerLinkProvider').mockImplementation((provider) => {
    providers.push(provider)
    return { dispose: vi.fn() }
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  let current = true
  const dispose = installPreviewTerminalLinks(terminal, {
    container,
    workspace: { ...workspace, ...overrides },
    isCurrent: () => current
  })
  return {
    terminal,
    providers,
    dispose,
    invalidate: () => {
      current = false
    }
  }
}
function links(provider: ILinkProvider): Promise<ILink[]> {
  return new Promise((resolve) => provider.provideLinks(1, (result) => resolve(result ?? [])))
}

describe('preview terminal document links', () => {
  it('opens relative markdown at its line and column in the card workspace', async () => {
    setPlatform('Macintosh')
    const preview = setup()
    expect(preview.providers).toHaveLength(1)
    const found = await links(preview.providers[0]!)
    expect(found).toHaveLength(1)
    found[0]!.activate(new MouseEvent('click', { metaKey: true }), found[0]!.text)
    await flushDoubleRaf()
    expect(doubles.openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/subdir/docs/guide.md',
        relativePath: 'subdir/docs/guide.md',
        worktreeId: 'wt-1'
      }),
      expect.anything()
    )
    expect(doubles.setMarkdownViewModeMock).toHaveBeenCalledWith(
      '/repo/subdir/docs/guide.md',
      'source'
    )
    await vi.waitFor(() =>
      expect(doubles.setPendingEditorRevealMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ line: 12, column: 4 })
      )
    )
    preview.dispose()
  })
  it('ignores a previously discovered link after its card changes', async () => {
    setPlatform('Linux')
    const preview = setup()
    const found = await links(preview.providers[0]!)
    preview.invalidate()
    found[0]!.activate(new MouseEvent('click', { ctrlKey: true }), found[0]!.text)
    await flushAsyncWork()
    expect(doubles.openFileMock).not.toHaveBeenCalled()
    preview.dispose()
  })
  it('handles OSC file URLs with Ctrl on Linux and ignores plain clicks', async () => {
    setPlatform('Linux')
    const preview = setup()
    const handler = preview.terminal.options.linkHandler
    expect(handler).toBeDefined()
    const range = { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } }
    handler!.activate(new MouseEvent('click'), 'file:///repo/notes.md#L5', range)
    await flushAsyncWork()
    expect(doubles.openFileMock).not.toHaveBeenCalled()
    handler!.activate(new MouseEvent('click', { ctrlKey: true }), 'file:///repo/notes.md#L5', range)
    await flushDoubleRaf()
    expect(doubles.openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/notes.md', worktreeId: 'wt-1' }),
      expect.anything()
    )
    preview.dispose()
  })
})

describe('preview link ownership and browser routing', () => {
  it('opens the same relative filename in each card’s own directory', async () => {
    setPlatform('Linux')
    const a = setup()
    const b = setup({ worktreeId: 'wt-2', cwd: '/other' })
    for (const preview of [a, b]) {
      const found = await links(preview.providers[0]!)
      found[0]!.activate(new MouseEvent('click', { ctrlKey: true }), found[0]!.text)
      await flushAsyncWork()
    }
    expect(
      doubles.openFileMock.mock.calls.map(([file]) => [file.worktreeId, file.filePath])
    ).toEqual([
      ['wt-1', '/repo/subdir/docs/guide.md'],
      ['wt-2', '/other/docs/guide.md']
    ])
    a.dispose()
    b.dispose()
  })
  it('probes and opens SSH files on the owning connection', async () => {
    setPlatform('Linux')
    hostState.value = 'ssh:host-b'
    vi.mocked(getConnectionId).mockReturnValue('host-b')
    const preview = setup({ executionHostId: 'ssh:host-b' })
    const found = await links(preview.providers[0]!)
    found[0]!.activate(new MouseEvent('click', { ctrlKey: true }), found[0]!.text)
    await flushAsyncWork()
    expect(doubles.fsPathExistsMock).toHaveBeenCalledWith({
      filePath: '/repo/subdir/docs/guide.md',
      connectionId: 'host-b'
    })
    expect(doubles.statMock).toHaveBeenCalledWith({
      filePath: '/repo/subdir/docs/guide.md',
      connectionId: 'host-b'
    })
    expect(doubles.authorizeExternalPathMock).not.toHaveBeenCalled()
    preview.dispose()
  })
  it.each(['ssh:host-b', 'runtime:host-b'] as const)(
    'routes web links through %s',
    async (host) => {
      setPlatform('Linux')
      hostState.value = host
      doubles.storeState.settings = { openLinksInApp: true }
      const openBrowser = vi.fn(async () => {})
      registerWorkspaceHttpLinkBrowserOpener(openBrowser)
      const preview = setup({ executionHostId: host })
      webCallbacks[0]!(new MouseEvent('click', { ctrlKey: true }), 'http://localhost:3000/')
      await flushAsyncWork()
      expect(openBrowser).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'wt-1',
          url: 'http://localhost:3000/',
          ...(host.startsWith('ssh:')
            ? { expectedSshConnectionId: 'host-b' }
            : { expectedRuntimeEnvironmentId: 'host-b' })
        })
      )
      expect(doubles.openUrlMock).not.toHaveBeenCalled()
      preview.dispose()
    }
  )
  it('keeps a popout URL external and requires the platform modifier', () => {
    setPlatform('Macintosh')
    doubles.openUrlMock.mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dispose = installPreviewTerminalLinks(new Terminal(), {
      container,
      isCurrent: () => true
    })
    webCallbacks[0]!(new MouseEvent('click'), 'https://example.com/')
    expect(doubles.openUrlMock).not.toHaveBeenCalled()
    webCallbacks[0]!(new MouseEvent('click', { metaKey: true }), 'https://example.com/')
    expect(doubles.openUrlMock).toHaveBeenCalledWith('https://example.com/')
    dispose()
    doubles.openUrlMock.mockClear()
    webCallbacks[0]!(new MouseEvent('click', { metaKey: true }), 'https://example.com/')
    expect(doubles.openUrlMock).not.toHaveBeenCalled()
  })
  it('invalidates a discovered file link when its execution host changes', async () => {
    setPlatform('Linux')
    const preview = setup()
    const found = await links(preview.providers[0]!)
    hostState.value = 'ssh:host-b'
    found[0]!.activate(new MouseEvent('click', { ctrlKey: true }), found[0]!.text)
    expect(doubles.openFileMock).not.toHaveBeenCalled()
    preview.dispose()
  })
})

it('discards file discovery completed after the connection is disposed', async () => {
  const probe = createDeferred<boolean>()
  vi.mocked(window.api.shell.pathExists).mockReturnValue(probe.promise)
  const preview = setup()
  const pending = links(preview.providers[0]!)
  await flushAsyncWork()
  preview.dispose()
  probe.resolve(true)
  expect(await pending).toEqual([])
})

it('uses folder workspace identity when opening documents', async () => {
  setPlatform('Linux')
  const preview = setup({ worktreeId: 'folder:docs', cwd: '/documents' })
  const found = await links(preview.providers[0]!)
  found[0]!.activate(new MouseEvent('click', { ctrlKey: true }), found[0]!.text)
  await flushAsyncWork()
  expect(doubles.openFileMock).toHaveBeenCalledWith(
    expect.objectContaining({
      filePath: '/documents/docs/guide.md',
      worktreeId: 'folder:docs'
    }),
    expect.anything()
  )
  preview.dispose()
})

it('keeps Shift+Ctrl as the local file default-app gesture', async () => {
  setPlatform('Windows')
  const preview = setup()
  const found = await links(preview.providers[0]!)
  found[0]!.activate(new MouseEvent('click', { ctrlKey: true, shiftKey: true }), found[0]!.text)
  await flushAsyncWork()
  expect(doubles.openFilePathMock).toHaveBeenCalledWith('/repo/subdir/docs/guide.md')
  expect(doubles.openFileMock).not.toHaveBeenCalled()
  preview.dispose()
})

it('resolves subsequent relative links from the cwd reported by the shell', async () => {
  setPlatform('Linux')
  const preview = setup()
  const handler = vi.mocked(preview.terminal.parser.registerOscHandler).mock.calls[0]?.[1]
  expect(handler).toBeDefined()
  handler!('file://host/repo/changed%20folder')
  const found = await links(preview.providers[0]!)
  found[0]!.activate(new MouseEvent('click', { ctrlKey: true }), found[0]!.text)
  await flushAsyncWork()
  expect(doubles.openFileMock).toHaveBeenCalledWith(
    expect.objectContaining({
      filePath: '/repo/changed folder/docs/guide.md'
    }),
    expect.anything()
  )
  preview.dispose()
})
