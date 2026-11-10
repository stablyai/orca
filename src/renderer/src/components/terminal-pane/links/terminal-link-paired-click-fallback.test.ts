import type { PathExistenceResult } from '../../../../../shared/file-access/path-existence-batch'
import { describe, expect, it, vi } from 'vitest'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'
import { openFilePathLinkAtBufferPosition } from './files/terminal-file-link-hit-testing'
import { openDetectedFilePath } from './files/terminal-file-open-routing'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { getTerminalPathExistsCacheKey } from './files/terminal-path-exists-cache'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  makeBuffer,
  makeBufferLine,
  makeExistsCache
} from './files/terminal-link-provider-buffer-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, openFileMock, runtimeEnvironmentCallMock, statMock } = doubles

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

const BUFFER = makeBuffer([
  makeBufferLine('/srv/repo/a.txt'),
  makeBufferLine('/srv/repo/b.txt'),
  makeBufferLine('/srv/repo/c.txt')
])

// What a host before the ENOTDIR fix returns for a path under a file.
const OLD_HOST_ENOTDIR = "ENOTDIR: not a directory, stat '/srv/repo/a.txt/srv/repo/b.txt'"

function runtimeKey(absolutePath: string): string {
  return getTerminalPathExistsCacheKey({
    absolutePath,
    isRemoteRuntimePath: true,
    runtimeEnvironmentId: 'env-1'
  })
}

type HostAnswer = { exists: boolean } | { error: string }

/** The host answers both the batched probe and the open's stat from one table. */
function hostAnswers(answer: (relativePath: string) => HostAnswer): void {
  runtimeEnvironmentCallMock.mockImplementation(async (args) => {
    const meta = { runtimeId: 'remote-runtime' }
    if (args.method === 'files.pathsExist') {
      return { id: 'rpc-1', ok: true, result: args.params.relativePaths.map(answer), _meta: meta }
    }
    const row = answer(args.params.relativePath)
    if ('exists' in row && row.exists) {
      return {
        id: 'rpc-1',
        ok: true,
        result: { size: 1, isDirectory: false, mtime: 1 },
        _meta: meta
      }
    }
    const message = 'error' in row ? row.error : 'ENOENT: no such file or directory'
    return { id: 'rpc-1', ok: false, error: { code: 'runtime_error', message }, _meta: meta }
  })
}

function clickPairedPath(
  buffer: ReturnType<typeof makeBuffer>,
  pathExistsCache = makeExistsCache()
): boolean {
  return openFilePathLinkAtBufferPosition(buffer, { x: 4, y: 1 }, 80, {
    startupCwd: '/srv/repo',
    worktreeId: 'wt-1',
    worktreePath: '/srv/repo',
    runtimeEnvironmentId: 'env-1',
    terminalHandle: 'term-1',
    pathExistsCache
  })
}

function clickFirstPath(onOpenFailure = vi.fn(), pathExistsCache = makeExistsCache()): boolean {
  return openFilePathLinkAtBufferPosition(BUFFER, { x: 4, y: 1 }, 80, {
    startupCwd: '/srv/repo',
    worktreeId: 'wt-1',
    worktreePath: '/srv/repo',
    runtimeEnvironmentId: 'env-1',
    terminalHandle: 'term-1',
    pathExistsCache,
    onOpenFailure
  })
}

describe('a modifier-click on a paired-server path followed by more paths', () => {
  it('opens the clicked path, not the guess joining it to the rows below', async () => {
    setPlatform('Macintosh')
    // Why an error row: hosts before the ENOTDIR fix cannot answer for `a.txt/...`.
    hostAnswers((path) => (path === 'a.txt' ? { exists: true } : { error: OLD_HOST_ENOTDIR }))
    const onOpenFailure = vi.fn()

    expect(clickFirstPath(onOpenFailure)).toBe(true)
    await flushDoubleRaf()

    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/srv/repo/a.txt' }),
      { forceContentReload: true }
    )
    expect(onOpenFailure).not.toHaveBeenCalled()
  })

  it('supersedes an earlier open still in flight as soon as an ambiguous click starts', async () => {
    setPlatform('Macintosh')
    const earlierStat = createDeferred<{ isDirectory: boolean }>()
    statMock.mockImplementationOnce(() => earlierStat.promise)
    const probe = createDeferred<boolean>()
    vi.mocked(window.api.shell.pathExists).mockImplementation(async (path: string) =>
      path === '/repo/a.txt' ? probe.promise : false
    )
    const deps = { startupCwd: '/repo', worktreeId: 'wt-1', worktreePath: '/repo' }

    openDetectedFilePath('/repo/earlier.txt', null, null, deps)
    openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('/repo/a.txt'), makeBufferLine('/repo/b.txt')]),
      { x: 4, y: 1 },
      80,
      deps
    )
    earlierStat.resolve({ isDirectory: false })
    await flushAsyncWork()
    expect(openFileMock).not.toHaveBeenCalled()

    probe.resolve(true)
    await flushDoubleRaf()
    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/a.txt' }),
      { forceContentReload: true }
    )
  })

  it('opens a wrapped network-share path whole, without stat-ing guesses unprompted', async () => {
    setPlatform('Windows')
    runtimeEnvironmentCallMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { worktree: 'wt-1', relativePath: null, absolutePath: null, exists: false },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const buffer = makeBuffer([
      makeBufferLine('//server/share/other/rep'),
      makeBufferLine('ort.txt')
    ])

    openFilePathLinkAtBufferPosition(buffer, { x: 4, y: 1 }, 80, {
      startupCwd: '/srv/repo',
      worktreeId: 'wt-1',
      worktreePath: '/srv/repo',
      runtimeEnvironmentId: 'env-1',
      terminalHandle: 'term-1',
      pathExistsCache: new Map()
    })
    await flushDoubleRaf()

    const asked = runtimeEnvironmentCallMock.mock.calls.map(([args]) => args.params?.pathText)
    expect(asked).toEqual(['//server/share/other/report.txt'])
  })

  it.each([
    ['report', ['//server/share/report.md']],
    ['details', []]
  ])('never opens an unchecked guess past a share path when clicking %s', async (word, opened) => {
    setPlatform('Windows')
    runtimeEnvironmentCallMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { worktree: 'wt-1', relativePath: null, absolutePath: null, exists: false },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const line = 'See //server/share/report.md for details'
    const buffer = makeBuffer([makeBufferLine(line)])

    openFilePathLinkAtBufferPosition(buffer, { x: line.indexOf(word) + 1, y: 1 }, 80, {
      startupCwd: '/srv/repo',
      worktreeId: 'wt-1',
      worktreePath: '/srv/repo',
      runtimeEnvironmentId: 'env-1',
      terminalHandle: 'term-1',
      pathExistsCache: new Map()
    })
    await flushDoubleRaf()

    const asked = runtimeEnvironmentCallMock.mock.calls.map(([args]) => args.params?.pathText)
    expect(asked).toEqual(opened)
  })

  it('leaves a click on prose beside a path to the terminal', async () => {
    setPlatform('Macintosh')
    const line = '/tmp/report.md completed successfully'
    const buffer = makeBuffer([makeBufferLine(line)])

    const handled = openFilePathLinkAtBufferPosition(
      buffer,
      { x: line.indexOf('completed') + 1, y: 1 },
      80,
      {
        startupCwd: '/srv/repo',
        worktreeId: 'wt-1',
        worktreePath: '/srv/repo',
        runtimeEnvironmentId: 'env-1',
        terminalHandle: 'term-1',
        pathExistsCache: new Map()
      }
    )
    await flushDoubleRaf()

    expect(handled).toBe(false)
    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalled()
  })

  it('opens the joined path when its checks fail and the visible prefix is known missing', async () => {
    setPlatform('Macintosh')
    hostAnswers((path) => ({ exists: path === 'report.txt' }))
    const answerOpen = runtimeEnvironmentCallMock.getMockImplementation()!
    runtimeEnvironmentCallMock.mockImplementation((args) =>
      args.method === 'files.pathsExist' ? Promise.reject(new Error('host busy')) : answerOpen(args)
    )
    const buffer = makeBuffer([
      makeBufferLine('/srv/repo/report'),
      makeBufferLine('.txt'),
      makeBufferLine('.map')
    ])

    clickPairedPath(buffer, makeExistsCache([[runtimeKey('/srv/repo/report'), false]]))
    await flushDoubleRaf()

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/srv/repo/report.txt' }),
      expect.anything()
    )
  })

  it('opens a wrapped share path whole even when its prefix is a known file', async () => {
    setPlatform('Windows')
    runtimeEnvironmentCallMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { worktree: 'wt-1', relativePath: null, absolutePath: null, exists: false },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const buffer = makeBuffer([makeBufferLine('//server/share/report'), makeBufferLine('.txt')])
    const pathExistsCache = makeExistsCache([[runtimeKey('//server/share/report'), true]])

    clickPairedPath(buffer, pathExistsCache)
    await flushDoubleRaf()

    const asked = runtimeEnvironmentCallMock.mock.calls.map(([args]) => args.params?.pathText)
    expect(asked).toEqual(['//server/share/report.txt'])
  })

  it('drops the click when its server is re-paired while candidates are checked', async () => {
    setPlatform('Macintosh')
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 1 }])
    const probe = createDeferred<unknown>()
    runtimeEnvironmentCallMock.mockImplementation((args) =>
      args.method === 'files.pathsExist' ? probe.promise : Promise.reject(new Error('unexpected'))
    )

    clickFirstPath()
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 1, pairingRevision: 2 }])
    probe.resolve({
      id: 'rpc-1',
      ok: true,
      result: [{ exists: false }, { exists: false }, { exists: true }],
      _meta: { runtimeId: 'remote-runtime' }
    })
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.stat' })
    )
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('drops the click when the workspace moves to another host while candidates are checked', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    const probe = createDeferred<PathExistenceResult[]>()
    const fsPathsExist = vi.fn(() => probe.promise)
    window.api.fs.pathsExist = fsPathsExist
    const deps = { startupCwd: '/home/u/proj', worktreeId: 'wt-1', worktreePath: '/home/u/proj' }

    openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('/home/u/proj/a.txt'), makeBufferLine('/home/u/proj/b.txt')]),
      { x: 4, y: 1 },
      80,
      deps
    )
    await flushAsyncWork()
    expect(fsPathsExist).toHaveBeenCalled()
    vi.mocked(getConnectionId).mockReturnValue(null)
    probe.resolve([{ exists: false }, { exists: true }])
    await flushDoubleRaf()

    expect(statMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('leaves an OSC 8 hyperlink to xterm when its label is a path known missing', () => {
    setPlatform('Macintosh')
    const label = makeBufferLine('nwparker/fix-123')
    const linked = Object.assign(label, {
      getCell: () => ({ hasExtendedAttrs: () => true, extended: { urlId: 1 } })
    })
    const pathExistsCache = makeExistsCache([
      [getTerminalPathExistsCacheKey({ absolutePath: '/repo/nwparker/fix-123' }), false]
    ])
    const onOpenFailure = vi.fn()

    expect(
      openFilePathLinkAtBufferPosition(makeBuffer([linked]), { x: 4, y: 1 }, 80, {
        startupCwd: '/repo',
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        pathExistsCache,
        onOpenFailure
      })
    ).toBe(false)
  })
})
