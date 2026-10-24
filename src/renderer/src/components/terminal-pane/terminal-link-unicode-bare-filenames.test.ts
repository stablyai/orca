// @vitest-environment happy-dom
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import type { ILink } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeAbsolutePath } from '../../lib/terminal-path-normalization'
import type { TerminalLinkActionRequest } from './terminal-link-action-request'
import { openFilePathLinkAtBufferPosition } from './terminal-link-handlers'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { createProviderSetup } from './terminal-link-provider-buffer-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, openFileMock } = doubles

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/language-detect', () => ({ detectLanguage: () => 'markdown' }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))

installTerminalLinkTestEnvironment(doubles)

const directories: string[] = []
const terminals: Terminal[] = []
afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Unicode bare filenames through the terminal link provider', () => {
  it.each(['精读-阻塞清单.md', '𠮷.md', 'cafe\u0301.md'])(
    'links ANSI-colored %s without an agent process',
    async (filename) => {
      setPlatform('Macintosh')
      const cwd = mkdtempSync(join(tmpdir(), 'orca-unicode-bare-'))
      directories.push(cwd)
      const target = join(cwd, filename)
      writeFileSync(target, '# fixture\n')
      const expectedTarget = normalizeAbsolutePath(target)?.normalized
      vi.mocked(window.api.shell.pathExists).mockImplementation(async (path) => existsSync(path))
      const terminal = new Terminal({ cols: 100, rows: 4, allowProposedApi: true })
      terminals.push(terminal)
      await new Promise<void>((resolve) =>
        terminal.write(`清单 (\x1b[34m${filename}\x1b[0m) · README.md`, resolve)
      )
      const row = terminal.buffer.active.getLine(0)!
      const request = vi.fn<(action: TerminalLinkActionRequest) => void>()
      const { provider } = createProviderSetup([row], new Map(), {
        startupCwd: cwd,
        worktreePath: cwd,
        getLinkActionContext: () => ({
          paneId: 1,
          pointerGesture: { canRequestAction: () => true, dispose: vi.fn() },
          claimPtyMouse: () => true,
          request,
          focusTerminal: vi.fn()
        })
      })
      const links = await new Promise<ILink[]>((resolve) =>
        provider.provideLinks(1, (provided) => resolve(provided ?? []))
      )
      expect(links.map((link) => link.text)).toEqual([filename])
      const link = links[0]!
      expect(link.range.start).toEqual({ x: 7, y: 1 })
      const closingColumn = Array.from({ length: terminal.cols }, (_, index) => index).find(
        (index) => row.getCell(index)?.getChars() === ')'
      )
      expect(link.range.end).toEqual({ x: closingColumn, y: 1 })
      expect(window.api.shell.pathExists).toHaveBeenCalledWith(expectedTarget)
      link.activate(new MouseEvent('click', { button: 0 }), link.text)
      expect(request).toHaveBeenCalledOnce()
      const action = request.mock.calls[0][0]
      expect(action).toMatchObject({ kind: 'file', destination: expectedTarget })
      action.primary?.run()
      await flushAsyncWork()
      expect(openFileMock).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: expectedTarget }),
        { forceContentReload: true }
      )
      openFileMock.mockClear()
      for (const x of [link.range.start.x, link.range.end.x]) {
        expect(
          openFilePathLinkAtBufferPosition(terminal.buffer.active, { x, y: 1 }, terminal.cols, {
            startupCwd: cwd,
            worktreePath: cwd,
            worktreeId: 'wt-1'
          })
        ).toBe(true)
      }
      expect(
        openFilePathLinkAtBufferPosition(
          terminal.buffer.active,
          { x: link.range.end.x + 1, y: 1 },
          terminal.cols,
          { startupCwd: cwd, worktreePath: cwd, worktreeId: 'wt-1' }
        )
      ).toBe(false)
      await flushAsyncWork()
      expect(openFileMock).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: expectedTarget }),
        {
          forceContentReload: true
        }
      )
    }
  )
})
