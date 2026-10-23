import { readFileSync } from 'node:fs'
import { Terminal } from '@xterm/headless'
import type { ILink } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getConnectionId } from '@/lib/connection-context'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  installTerminalLinkTestEnvironment
} from './terminal-link-handlers-test-harness'
import {
  createProviderSetup,
  makeBufferLine,
  type TestBufferLine
} from './terminal-link-provider-buffer-fixtures'

const doubles = createTerminalLinkTestDoubles()
const { storeState, fsPathExistsMock, runtimeEnvironmentCallMock, statMock } = doubles
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/language-detect', () => ({ detectLanguage: () => 'plaintext' }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))
installTerminalLinkTestEnvironment(doubles)

const firstPath = '/home/alice/dev/notes/README.md'
const secondPath = '/home/alice/dev/renderer/package.json'
const capture = readFileSync(
  new URL('./terminal-link-transcripts/consecutive-absolute-file-paths.txt', import.meta.url),
  'utf8'
)
const terminals: Terminal[] = []
afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
})

async function replayRows(data = capture): Promise<TestBufferLine[]> {
  const terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
  terminals.push(terminal)
  await new Promise<void>((resolve) => terminal.write(data, resolve))
  const rows: TestBufferLine[] = []
  for (let y = 0; y < terminal.rows; y++) {
    const row = terminal.buffer.active.getLine(y)
    if (row) {
      rows.push(row)
    }
  }
  return rows
}

function hover(
  provider: ReturnType<typeof createProviderSetup>['provider'],
  row: number
): Promise<ILink[]> {
  return new Promise((resolve) => provider.provideLinks(row, (links) => resolve(links ?? [])))
}

function sshProbe(): void {
  vi.mocked(getConnectionId).mockReturnValue('ssh-notes')
  fsPathExistsMock.mockImplementation(async ({ filePath }) => {
    if (filePath === firstPath || filePath === secondPath) {
      return true
    }
    throw new Error('ENOTDIR: joined path is not a file')
  })
}

describe('terminal link candidates fail independently', () => {
  it('keeps valid SSH links on consecutive captured rows when the joined path probe rejects', async () => {
    const rows = await replayRows()
    expect(
      rows.slice(0, 2).map((row) => [row.translateToString(true), row.isWrapped, row.length])
    ).toEqual([
      [firstPath, false, 80],
      [secondPath, false, 80]
    ])
    sshProbe()
    const cache = new Map<string, boolean>()
    const { provider } = createProviderSetup(rows, cache, {
      startupCwd: '/home/alice/dev',
      worktreePath: '/home/alice/dev'
    })
    expect((await hover(provider, 1)).map((link) => link.text)).toEqual([firstPath])
    expect((await hover(provider, 2)).map((link) => link.text)).toEqual([secondPath])
    expect(fsPathExistsMock).toHaveBeenCalledWith({
      filePath: firstPath + secondPath,
      connectionId: 'ssh-notes'
    })
    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
    expect([...cache.values()]).toEqual([true, true])
    expect([...cache.keys()].some((key) => key.includes(firstPath + secondPath))).toBe(false)
  })

  it('has the same valid SSH links with a blank-row separator', async () => {
    const rows = await replayRows(capture.replace(`${firstPath}\r\n`, `${firstPath}\r\n\r\n`))
    sshProbe()
    const { provider } = createProviderSetup(rows, new Map(), {
      startupCwd: '/home/alice/dev',
      worktreePath: '/home/alice/dev'
    })
    expect((await hover(provider, 1)).map((link) => link.text)).toEqual([firstPath])
    expect((await hover(provider, 3)).map((link) => link.text)).toEqual([secondPath])
  })

  it('preserves a real hard-wrapped path beside a rejected joined candidate', async () => {
    const rows = await replayRows(`/home/alice/dev/notes/\r\nREADME.md\r\n${secondPath}\r\n`)
    sshProbe()
    const { provider } = createProviderSetup(rows, new Map(), {
      startupCwd: '/home/alice/dev',
      worktreePath: '/home/alice/dev'
    })
    const links = await hover(provider, 1)
    expect(links.map((link) => link.text)).toEqual([firstPath])
    expect(links[0]?.range).toEqual({ start: { x: 1, y: 1 }, end: { x: 'README.md'.length, y: 2 } })
  })

  it('preserves verified client links when an uncached neighbor probe fails', async () => {
    const rows = await replayRows()
    const cache = new Map([
      [`active\0${firstPath}`, true],
      [`active\0${secondPath}`, true]
    ])
    window.api.shell.pathsExist = vi.fn().mockRejectedValue(new Error('ENOTDIR: joined path'))
    const { provider } = createProviderSetup(rows, cache, {
      startupCwd: '/home/alice/dev',
      worktreePath: '/home/alice/dev'
    })
    expect((await hover(provider, 1)).map((link) => link.text)).toEqual([firstPath])
    expect(fsPathExistsMock).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalled()
    expect([...cache.values()]).toEqual([true, true])
  })

  it('uses paired-host per-path answers without consulting the client filesystem', async () => {
    const rows = await replayRows()
    runtimeEnvironmentCallMock.mockImplementation(async ({ method, params }) => {
      if (method !== 'files.pathsExist' || !Array.isArray(params?.relativePaths)) {
        throw new Error('Unexpected remote probe')
      }
      return {
        id: 'paths',
        ok: true,
        result: params.relativePaths.map((path) =>
          path === 'notes/README.md' || path === 'renderer/package.json'
            ? { exists: true }
            : { error: 'ENOTDIR: joined path' }
        ),
        _meta: { runtimeId: 'remote' }
      }
    })
    const cache = new Map<string, boolean>()
    const { provider } = createProviderSetup(rows, cache, {
      startupCwd: '/home/alice/dev',
      worktreePath: '/home/alice/dev',
      runtimeEnvironmentId: 'env-notes'
    })
    expect((await hover(provider, 1)).map((link) => link.text)).toEqual([firstPath])
    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-notes', method: 'files.pathsExist' })
    )
    expect(fsPathExistsMock).not.toHaveBeenCalled()
    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
    expect([...cache.values()]).toEqual([true])
  })

  it('keeps host-granted files bound to their printing terminal when a neighboring candidate fails', async () => {
    const rows = await replayRows()
    runtimeEnvironmentCallMock.mockImplementation(async ({ method, params }) => {
      if (method !== 'files.resolveTerminalPath') {
        throw new Error('Unexpected remote probe')
      }
      const path = params?.pathText
      if (path !== firstPath && path !== secondPath) {
        throw new Error('ENOTDIR: joined path')
      }
      return {
        id: 'grant',
        ok: true,
        result: {
          worktree: 'wt-1',
          relativePath: null,
          absolutePath: path,
          exists: true,
          isDirectory: false,
          openTarget: {
            kind: 'absolute-file',
            provider: 'local',
            absolutePath: path,
            grantId: 'terminal-grant'
          }
        },
        _meta: { runtimeId: 'remote' }
      }
    })
    const { provider } = createProviderSetup(rows, new Map(), {
      startupCwd: '/srv/repo',
      worktreePath: '/srv/repo',
      runtimeEnvironmentId: 'env-notes',
      getRuntimeTerminalHandleForPane: () => 'term-notes'
    })
    expect((await hover(provider, 1)).map((link) => link.text)).toEqual([firstPath])
    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.resolveTerminalPath',
        params: expect.objectContaining({ pathText: firstPath, terminal: 'term-notes' })
      })
    )
    expect(statMock).not.toHaveBeenCalled()
    expect(fsPathExistsMock).not.toHaveBeenCalled()
    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
  })

  it('does not cache a transport failure as missing and can retry the next hover', async () => {
    const rows = await replayRows()
    vi.mocked(getConnectionId).mockReturnValue('ssh-notes')
    fsPathExistsMock.mockRejectedValue(new Error('Connection lost'))
    const cache = new Map<string, boolean>()
    const { provider } = createProviderSetup(rows, cache, {
      startupCwd: '/home/alice/dev',
      worktreePath: '/home/alice/dev'
    })
    expect(await hover(provider, 1)).toEqual([])
    expect(cache.size).toBe(0)
    sshProbe()
    expect((await hover(provider, 1)).map((link) => link.text)).toEqual([firstPath])
    expect([...cache.values()]).toEqual([true])
  })

  it('drops a verified candidate when its buffer row changes while another candidate rejects', async () => {
    const rows = await replayRows()
    const pending = createDeferred<boolean>()
    vi.mocked(getConnectionId).mockReturnValue('ssh-notes')
    fsPathExistsMock.mockImplementation(async ({ filePath }) => {
      if (filePath === firstPath) {
        return pending.promise
      }
      throw new Error('ENOTDIR: joined path')
    })
    const { provider } = createProviderSetup(rows, new Map(), {
      startupCwd: '/home/alice/dev',
      worktreePath: '/home/alice/dev'
    })
    const callback = vi.fn()
    provider.provideLinks(1, callback)
    await flushAsyncWork()
    rows[0] = makeBufferLine('changed terminal output')
    pending.resolve(true)
    await flushAsyncWork()
    await flushAsyncWork()
    expect(callback).not.toHaveBeenCalled()
  })
})
