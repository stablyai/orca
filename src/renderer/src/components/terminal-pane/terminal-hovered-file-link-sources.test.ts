import type { IDisposable, ILink, Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { getConnectionId } from '@/lib/connection-context'
import {
  revealTerminalFileLink,
  terminalFileLinkRevealAtMouseEvent,
  type TerminalFileLinkReveal
} from './terminal-hovered-file-link'
import { createFilePathLinkProvider, getTerminalFileOpenHint } from './terminal-link-handlers'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'
import { makeBufferLine, type TestBufferLine } from './terminal-link-provider-buffer-fixtures'
import { setHoveredOscFileLink } from './terminal-osc-link-routing'

const doubles = createTerminalLinkTestDoubles()
const { storeState, fsPathExistsMock, openFilePathMock, statMock } = doubles

vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeState }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: () => 'plaintext'
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the link callbacks ignore their event.
const hoverEvent = {} as MouseEvent
const CELL = 10
const localTransport = { getPtyId: () => 'pty-1' }

function makeTerminal(rows: TestBufferLine[] = []): Terminal {
  const screen = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 80 * CELL, height: 24 * CELL })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: link detection and pointer hit-testing read only these fields.
  return {
    cols: 80,
    rows: 24,
    element: { querySelector: () => screen },
    buffer: { active: { viewportY: 0, getLine: (y: number) => rows[y] } }
  } as unknown as Terminal
}

/** What the context menu would offer for a right-click on 1-based cell (column, row). */
function revealAt(terminal: Terminal, column: number, row: number): TerminalFileLinkReveal | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the pointer coordinates are read.
  const event = { clientX: (column - 1) * CELL + 1, clientY: (row - 1) * CELL + 1 } as MouseEvent
  return terminalFileLinkRevealAtMouseEvent(terminal, event, localTransport)
}

async function provideLinks(
  terminal: Terminal,
  pathExistsCache = new Map([['active\0/repo/src/foo.ts', true]])
): Promise<ILink[]> {
  const managerRef = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider only looks its pane up by id.
    current: { getPanes: () => [{ id: 1, terminal }] } as unknown as PaneManager
  }
  const provider = createFilePathLinkProvider(
    1,
    {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      startupCwd: '/repo',
      managerRef,
      linkProviderDisposablesRef: { current: new Map<number, IDisposable>() },
      pathExistsCache
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider only writes the tooltip text and display.
    { textContent: '', style: { display: '' } } as unknown as HTMLElement,
    getTerminalFileOpenHint()
  )
  return new Promise<ILink[]>((resolve) => {
    provider.provideLinks(1, (provided) => resolve(provided ?? []))
  })
}

describe('detected path links', () => {
  it('offers the hovered path for reveal, resolved against the pane cwd, until the pointer leaves', async () => {
    setPlatform('Macintosh')
    const terminal = makeTerminal([makeBufferLine('Wrote src/foo.ts:42')])
    const [link] = await provideLinks(terminal)

    link!.hover?.(hoverEvent, link!.text)
    expect(revealAt(terminal, 'Wrote '.length + 1, 1)).toEqual({
      path: '/repo/src/foo.ts',
      blocked: false
    })
    expect(revealAt(terminal, 1, 1)).toBeNull()

    link!.leave?.(hoverEvent, link!.text)
    expect(revealAt(terminal, 'Wrote '.length + 1, 1)).toBeNull()
  })

  it('blocks reveal for a path that lives on an SSH host', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    const terminal = makeTerminal([makeBufferLine('Wrote src/foo.ts:42')])
    const [link] = await provideLinks(terminal, new Map([['ssh:ssh-1\0/repo/src/foo.ts', true]]))

    link!.hover?.(hoverEvent, link!.text)

    expect(revealAt(terminal, 'Wrote '.length + 1, 1)).toEqual({
      path: '/repo/src/foo.ts',
      blocked: true
    })
  })
})

describe('OSC 8 hyperlinks', () => {
  const range = { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } }
  const pathExists = vi.fn<(path: string) => Promise<boolean>>()

  function deps(overrides: Partial<Parameters<typeof setHoveredOscFileLink>[3]> = {}) {
    return {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      startupCwd: '/repo/packages/app',
      pathExistsCache: new Map<string, boolean>(),
      ...overrides
    }
  }

  /** Lets the hover's existence probe, batched on a microtask, settle. */
  async function existenceProbeSettled(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(() => {
    pathExists.mockReset().mockResolvedValue(true)
    window.api.shell.pathExists = pathExists
  })

  it('offers a file:// link target for reveal once the file is found', async () => {
    setPlatform('Macintosh')
    const terminal = makeTerminal()

    setHoveredOscFileLink(terminal, 'file:///repo/recordings/demo.mp4', range, deps())
    expect(revealAt(terminal, 3, 1)).toBeNull()

    await existenceProbeSettled()
    expect(pathExists).toHaveBeenCalledWith('/repo/recordings/demo.mp4')
    expect(revealAt(terminal, 3, 1)).toEqual({ path: '/repo/recordings/demo.mp4', blocked: false })
  })

  it('offers nothing for a link to a file that does not exist', async () => {
    setPlatform('Macintosh')
    pathExists.mockResolvedValue(false)
    const terminal = makeTerminal()

    setHoveredOscFileLink(terminal, 'file:///repo/gone.txt', range, deps())
    await existenceProbeSettled()

    expect(revealAt(terminal, 3, 1)).toBeNull()
  })

  it('asks the host about a file once, then answers later hovers from the pane cache', async () => {
    setPlatform('Macintosh')
    const terminal = makeTerminal()
    const paneDeps = deps()

    setHoveredOscFileLink(terminal, 'file:///repo/a.txt', range, paneDeps)
    await existenceProbeSettled()
    setHoveredOscFileLink(terminal, 'file:///repo/a.txt', range, paneDeps)
    await existenceProbeSettled()

    expect(pathExists).toHaveBeenCalledTimes(1)
    expect(revealAt(terminal, 3, 1)).toEqual({ path: '/repo/a.txt', blocked: false })
  })

  it('re-asks about a file that was missing, so one created after the first hover is offered', async () => {
    setPlatform('Macintosh')
    pathExists.mockResolvedValueOnce(false)
    const terminal = makeTerminal()
    const paneDeps = deps()

    setHoveredOscFileLink(terminal, 'file:///repo/out/report.md', range, paneDeps)
    await existenceProbeSettled()
    expect(revealAt(terminal, 3, 1)).toBeNull()

    setHoveredOscFileLink(terminal, 'file:///repo/out/report.md', range, paneDeps)
    await existenceProbeSettled()
    expect(revealAt(terminal, 3, 1)).toEqual({ path: '/repo/out/report.md', blocked: false })

    setHoveredOscFileLink(terminal, 'file:///repo/out/report.md', range, paneDeps)
    await existenceProbeSettled()
    expect(pathExists).toHaveBeenCalledTimes(2)
  })

  it('leaves a path printed later linkable when its hyperlink was hovered before the file existed', async () => {
    setPlatform('Macintosh')
    pathExists.mockResolvedValueOnce(false)
    const pathExistsCache = new Map<string, boolean>()
    const terminal = makeTerminal([makeBufferLine('Wrote out/report.md')])

    setHoveredOscFileLink(terminal, 'file:///repo/out/report.md', range, deps({ pathExistsCache }))
    await existenceProbeSettled()

    expect(await provideLinks(terminal, pathExistsCache)).toHaveLength(1)
  })

  describe('revealing the offered link', () => {
    const openInFileManager = vi.fn()

    async function revealHovered(rawText: string): Promise<void> {
      const terminal = makeTerminal()
      setHoveredOscFileLink(terminal, rawText, range, deps())
      await existenceProbeSettled()
      const reveal = revealAt(terminal, 3, 1)
      if (!reveal) {
        throw new Error('the hovered link was not offered for reveal')
      }
      await revealTerminalFileLink(reveal)
    }

    beforeEach(() => {
      setPlatform('Macintosh')
      openInFileManager.mockReset().mockResolvedValue({ ok: true })
      window.api.shell.openInFileManager = openInFileManager
    })

    it('opens a directory itself rather than selecting it in its parent', async () => {
      statMock.mockResolvedValue({ isDirectory: true })

      await revealHovered('file:///repo/recordings')

      expect(openFilePathMock).toHaveBeenCalledWith('/repo/recordings')
      expect(openInFileManager).not.toHaveBeenCalled()
    })

    it('selects a file in its parent folder', async () => {
      statMock.mockResolvedValue({ isDirectory: false })

      await revealHovered('file:///repo/recordings/demo.mp4')

      expect(openInFileManager).toHaveBeenCalledWith('/repo/recordings/demo.mp4')
      expect(openFilePathMock).not.toHaveBeenCalled()
    })

    it('falls back to the shared reveal, which reports the failure, when the path has gone', async () => {
      statMock.mockRejectedValue(new Error('ENOENT: no such file or directory'))

      await revealHovered('file:///repo/recordings')

      expect(openInFileManager).toHaveBeenCalledWith('/repo/recordings')
      expect(openFilePathMock).not.toHaveBeenCalled()
    })

    it('leaves a directory to the shared reveal, which refuses it, once a remote runtime is focused', async () => {
      statMock.mockResolvedValue({ isDirectory: true })
      const terminal = makeTerminal()
      setHoveredOscFileLink(terminal, 'file:///repo/recordings', range, deps())
      await existenceProbeSettled()
      const reveal = revealAt(terminal, 3, 1)
      storeState.settings = { activeRuntimeEnvironmentId: 'env-1' }

      await revealTerminalFileLink(reveal!)

      expect(openInFileManager).toHaveBeenCalledWith('/repo/recordings')
      expect(openFilePathMock).not.toHaveBeenCalled()
    })
  })

  it('resolves a bare relative path against the pane cwd', async () => {
    setPlatform('Macintosh')
    const terminal = makeTerminal()

    setHoveredOscFileLink(terminal, 'src/index.ts:7', range, deps())
    await existenceProbeSettled()

    expect(revealAt(terminal, 3, 1)?.path).toBe('/repo/packages/app/src/index.ts')
  })

  it('offers a WSL pane link as the Windows path the file manager understands', async () => {
    setPlatform('Windows')
    const terminal = makeTerminal()

    setHoveredOscFileLink(
      terminal,
      'file:///root/workspace/myrepo/README.md',
      range,
      deps({
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\repo',
        startupCwd: undefined,
        wslDistro: 'Ubuntu'
      })
    )
    await existenceProbeSettled()

    expect(revealAt(terminal, 3, 1)).toEqual({
      path: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md',
      blocked: false
    })
  })

  it('offers nothing for a web link, and forgets the file link hovered before it', async () => {
    setPlatform('Macintosh')
    const terminal = makeTerminal()
    setHoveredOscFileLink(terminal, 'file:///repo/a.txt', range, deps())
    await existenceProbeSettled()

    setHoveredOscFileLink(terminal, 'https://example.com/a.txt', range, deps())

    expect(revealAt(terminal, 3, 1)).toBeNull()
  })

  it('offers nothing for a file on another machine', async () => {
    setPlatform('Macintosh')
    const terminal = makeTerminal()

    setHoveredOscFileLink(terminal, 'file://buildbox/repo/a.txt', range, deps())
    await existenceProbeSettled()

    expect(revealAt(terminal, 3, 1)).toBeNull()
    expect(pathExists).not.toHaveBeenCalled()
  })

  it('blocks reveal for a file on an SSH host without asking that host about it', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    const terminal = makeTerminal()

    setHoveredOscFileLink(terminal, 'file:///repo/a.txt', range, deps())
    expect(revealAt(terminal, 3, 1)).toEqual({ path: '/repo/a.txt', blocked: true })

    await existenceProbeSettled()
    expect(pathExists).not.toHaveBeenCalled()
    expect(fsPathExistsMock).not.toHaveBeenCalled()
  })
})
