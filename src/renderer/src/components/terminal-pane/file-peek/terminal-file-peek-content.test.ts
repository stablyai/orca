import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../../../../shared/filesystem-entry-types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCache } from '@/runtime/runtime-rpc-client'
import { FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY } from '../../../../../shared/files-runtime-capabilities'
import type { FileLinkTarget } from '../terminal-file-link-target'
import { canPeekTerminalFileTarget, loadTerminalFilePeek } from './terminal-file-peek-content'

const hostStatuses = vi.hoisted(() => new Map<string, { status: { capabilities: string[] } }>())
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ runtimeStatusByEnvironmentId: hostStatuses })
  }
}))

type RangeRequest = {
  filePath?: string
  offset: number
  length: number
  wakeWslDistro?: boolean
}
type RpcRequest = {
  selector?: string
  method: string
  params?: { offset?: number; length?: number; wakeWslDistro?: boolean }
}

let bytes = Buffer.from('const answer = 42\n')
let snapshot = { size: bytes.length, isDirectory: false, mtime: 1 }
let entries: DirEntry[] = []
let legacyDirectoryReply: DirEntry[] | null = null
const fsStat = vi.fn(async (_args: { filePath: string; wakeWslDistro?: boolean }) => snapshot)
const fsReadFileChunk = vi.fn(async ({ offset, length }: RangeRequest) => chunk(offset, length))
const fsReadDir = vi.fn(async (_args: { dirPath: string; wakeWslDistro?: boolean }) => entries)
const fsReadFile = vi.fn()
const rpcCall = vi.fn(async ({ method, params }: RpcRequest): Promise<unknown> => {
  switch (method) {
    case 'status.get':
      return {
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'peek-host',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: [FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY]
        }
      }
    case 'files.stat':
      return { id: 'stat', ok: true, result: snapshot }
    case 'files.readChunk':
      if (params?.offset === undefined || params.length === undefined) {
        throw new Error('Missing range')
      }
      return {
        id: 'chunk',
        ok: true,
        result: chunk(params.offset, params.length)
      }
    case 'files.readDir':
      return {
        id: 'directory',
        ok: true,
        result: legacyDirectoryReply ?? {
          entries,
          total: entries.length,
          hasMore: false
        }
      }
    default:
      throw new Error(`Unexpected RPC ${method}`)
  }
})

function chunk(offset: number, length: number) {
  const data = bytes.subarray(offset, offset + length)
  return {
    contentBase64: data.toString('base64'),
    bytesRead: data.length,
    eof: offset + data.length >= bytes.length
  }
}

function fileTarget(overrides: Partial<FileLinkTarget> = {}): FileLinkTarget {
  return {
    absolutePath: '/workspace/example.ts',
    line: null,
    column: null,
    fileContext: {
      target: { kind: 'local' },
      worktreeId: 'folder:notes',
      worktreePath: '/workspace',
      sourceHostResolved: true
    },
    isRemoteRuntimePath: false,
    cacheKey: 'peek',
    isKnownWorktreeRoot: false,
    ...overrides
  }
}

function remoteTarget(absolutePath = '/workspace/example.ts'): FileLinkTarget {
  const target = fileTarget({ absolutePath, isRemoteRuntimePath: true })
  return {
    ...target,
    fileContext: {
      ...target.fileContext,
      target: { kind: 'environment', environmentId: 'peek-env' }
    }
  }
}

function setContent(source: string): void {
  bytes = Buffer.from(source)
  snapshot = { size: bytes.length, isDirectory: false, mtime: 1 }
}

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCache()
  hostStatuses.clear()
  entries = []
  legacyDirectoryReply = null
  setContent('const answer = 42\n')
  vi.stubGlobal('window', {
    api: {
      fs: {
        stat: fsStat,
        readFileChunk: fsReadFileChunk,
        readDir: fsReadDir,
        readFile: fsReadFile
      },
      runtimeEnvironments: { call: rpcCall }
    }
  })
})

afterEach(() => {
  expect(fsReadFile).not.toHaveBeenCalled()
  for (const [args] of [
    ...fsStat.mock.calls,
    ...fsReadFileChunk.mock.calls,
    ...fsReadDir.mock.calls
  ]) {
    expect(args.wakeWslDistro).not.toBe(true)
  }
  for (const [args] of rpcCall.mock.calls) {
    expect(args.params?.wakeWslDistro).not.toBe(true)
  }
  const ranges = [
    ...fsReadFileChunk.mock.calls.map(([args]) => args),
    ...rpcCall.mock.calls
      .filter(([args]) => args.method === 'files.readChunk')
      .map(([args]) => args.params)
  ]
  let requested = 0
  for (const range of ranges) {
    expect(range?.length).toBeGreaterThan(0)
    expect(range?.length).toBeLessThanOrEqual(64 * 1024)
    requested += range?.length ?? 0
  }
  expect(requested).toBeLessThanOrEqual(1024 * 1024)
  vi.unstubAllGlobals()
})

describe('loadTerminalFilePeek', () => {
  it('previews a remote folder-workspace root directly through a 21-entry directory page', async () => {
    snapshot = { size: 0, isDirectory: true, mtime: 1 }
    entries = [
      ...Array.from({ length: 20 }, (_, index) => ({
        name: `file${20 - index}`,
        isDirectory: false,
        isSymlink: false
      })),
      { name: 'folder', isDirectory: true, isSymlink: false }
    ]
    hostStatuses.set('peek-env', {
      status: { capabilities: [FILE_READ_DIR_PAGED_RUNTIME_CAPABILITY] }
    })
    const result = await loadTerminalFilePeek(
      remoteTarget('/workspace'),
      new AbortController().signal
    )
    expect(result?.kind).toBe('directory')
    if (result?.kind !== 'directory') {
      throw new Error('Expected directory')
    }
    expect(result.entries).toHaveLength(20)
    expect(result.entries[0].name).toBe('folder')
    expect(result.entries[1].name).toBe('file1')
    expect(result.entries[2].name).toBe('file2')
    expect(result.entries.at(-1)?.name).toBe('file19')
    expect(result.hasMore).toBe(true)
    expect(rpcCall).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'files.stat' }))
    expect(rpcCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'peek-env',
        method: 'files.readDir',
        params: { worktree: 'id:folder:notes', relativePath: '', limit: 21 }
      })
    )
    expect(fsStat).not.toHaveBeenCalled()
    expect(fsReadDir).not.toHaveBeenCalled()
    expect(fsReadFileChunk).not.toHaveBeenCalled()
  })

  it.each([
    {
      path: '/workspace/picture.PNG',
      size: 10 * 1024 * 1024,
      expected: { kind: 'image', sizeBytes: 10 * 1024 * 1024 }
    },
    {
      path: '/workspace/oversized.jpg',
      size: 10 * 1024 * 1024 + 1,
      expected: { kind: 'notice', reason: 'too-large' }
    },
    {
      path: '/workspace/manual.pdf',
      size: 10,
      expected: { kind: 'notice', reason: 'unsupported' }
    },
    {
      path: '/workspace/song.mp3',
      size: 10,
      expected: { kind: 'notice', reason: 'unsupported' }
    },
    {
      path: '/workspace/movie.mp4',
      size: 10,
      expected: { kind: 'notice', reason: 'unsupported' }
    }
  ])(
    'classifies $path from metadata without reading pixels or unsupported content',
    async ({ path, size, expected }) => {
      snapshot = { size, isDirectory: false, mtime: 1 }
      expect(
        await loadTerminalFilePeek(fileTarget({ absolutePath: path }), new AbortController().signal)
      ).toEqual({ path, ...expected })
      expect(fsReadFileChunk).not.toHaveBeenCalled()
    }
  )

  it('returns a UTF-8-safe 16 KiB Markdown prefix without reading the rest', async () => {
    setContent(`${'a'.repeat(16383)}🦀 tail`)
    const path = '/workspace/README.MD'
    expect(
      await loadTerminalFilePeek(fileTarget({ absolutePath: path }), new AbortController().signal)
    ).toEqual({ kind: 'markdown', path, source: 'a'.repeat(16383) })
    expect(fsReadFileChunk).toHaveBeenCalledTimes(1)
    expect(fsReadFileChunk).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 0, length: 16384 })
    )
  })

  it('treats Markdown line references as source text', async () => {
    setContent('# Heading\n**source**')
    expect(
      await loadTerminalFilePeek(
        fileTarget({ absolutePath: '/workspace/readme.md', line: 2 }),
        new AbortController().signal
      )
    ).toEqual({
      kind: 'text',
      path: '/workspace/readme.md',
      language: 'markdown',
      firstLineNumber: 1,
      targetLine: 2,
      lines: ['# Heading', '**source**'],
      truncatedLines: false
    })
  })

  it.each(['/workspace/source.ts', '/workspace/readme.md'])(
    'rejects NUL in the first 8 KiB of $0 even after the visible lines',
    async (path) => {
      setContent(`${'a\n'.repeat(20)}${'b'.repeat(8151)}\0tail`)
      expect(
        await loadTerminalFilePeek(fileTarget({ absolutePath: path }), new AbortController().signal)
      ).toEqual({ kind: 'notice', path, reason: 'binary' })
      expect(fsReadFileChunk).toHaveBeenCalledTimes(1)
    }
  )

  it('does not classify a NUL after the first 8 KiB as binary', async () => {
    setContent(`${'x'.repeat(8192)}\0tail`)
    expect(await loadTerminalFilePeek(fileTarget(), new AbortController().signal)).toMatchObject({
      kind: 'text',
      lines: ['x'.repeat(240)],
      truncatedLines: true
    })
  })

  it('routes environment text reads through RPC with a workspace-relative address', async () => {
    setContent('remote café\r\nsecond')
    const target = remoteTarget()
    expect(await loadTerminalFilePeek(target, new AbortController().signal)).toEqual({
      kind: 'text',
      path: target.absolutePath,
      language: 'typescript',
      firstLineNumber: 1,
      targetLine: null,
      lines: ['remote café', 'second'],
      truncatedLines: false
    })
    expect(rpcCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'peek-env',
        method: 'files.readChunk',
        params: {
          worktree: 'id:folder:notes',
          relativePath: 'example.ts',
          offset: 0,
          length: bytes.length
        }
      })
    )
    expect(fsStat).not.toHaveBeenCalled()
    expect(fsReadFileChunk).not.toHaveBeenCalled()
  })

  it('derives an environment address from Windows-drive paths independently of the client OS', async () => {
    const target = remoteTarget('c:\\notes\\src\\example.ts')
    target.fileContext.worktreePath = 'C:\\Notes'
    expect(await loadTerminalFilePeek(target, new AbortController().signal)).toMatchObject({
      kind: 'text',
      language: 'typescript'
    })
    expect(rpcCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.stat',
        params: { worktree: 'id:folder:notes', relativePath: 'src/example.ts' }
      })
    )
    expect(fsStat).not.toHaveBeenCalled()
  })

  it.each([
    { root: 'C:\\notes', path: 'C:\\notes\\example.ts' },
    {
      root: '\\\\wsl.localhost\\Ubuntu\\home\\notes',
      path: '\\\\wsl.localhost\\Ubuntu\\home\\notes\\example.ts'
    }
  ])(
    'keeps the mapped Windows/WSL host address $path and never requests a wake',
    async ({ root, path }) => {
      const target = fileTarget({ absolutePath: path })
      target.fileContext.worktreePath = root
      expect(await loadTerminalFilePeek(target, new AbortController().signal)).toMatchObject({
        kind: 'text',
        path,
        lines: ['const answer = 42', '']
      })
      expect(fsStat).toHaveBeenCalledWith(expect.objectContaining({ filePath: path }))
      expect(fsReadFileChunk).toHaveBeenCalledWith(expect.objectContaining({ filePath: path }))
      expect(rpcCall).not.toHaveBeenCalled()
    }
  )

  it.each(['outside', 'missing-workspace', 'unresolved-owner'])(
    'keeps the tooltip for an unaddressable %s target',
    async (scenario) => {
      const target = remoteTarget(
        scenario === 'outside' ? '/outside/file.ts' : '/workspace/example.ts'
      )
      if (scenario === 'missing-workspace') {
        target.fileContext.worktreeId = null
      }
      if (scenario === 'unresolved-owner') {
        target.fileContext.sourceHostResolved = false
      }
      expect(canPeekTerminalFileTarget(target)).toBe(false)
      expect(await loadTerminalFilePeek(target, new AbortController().signal)).toBeNull()
      expect(fsStat).not.toHaveBeenCalled()
      expect(fsReadFileChunk).not.toHaveBeenCalled()
      expect(rpcCall).not.toHaveBeenCalled()
    }
  )

  it('treats a remote target inside its workspace as peekable', () => {
    expect(canPeekTerminalFileTarget(remoteTarget('/workspace/example.ts'))).toBe(true)
  })

  it('lists local directory entries in shared natural order, including dotfiles', async () => {
    snapshot.isDirectory = true
    entries = [
      { name: 'file10', isDirectory: false, isSymlink: false },
      { name: '.hidden', isDirectory: false, isSymlink: false },
      { name: 'file2', isDirectory: false, isSymlink: false },
      { name: 'folder', isDirectory: true, isSymlink: true }
    ]
    const result = await loadTerminalFilePeek(
      fileTarget({ absolutePath: '/workspace/folder.png' }),
      new AbortController().signal
    )
    expect(result?.kind).toBe('directory')
    if (result?.kind !== 'directory') {
      throw new Error('Expected directory')
    }
    expect(result.entries.map((entry) => entry.name)).toEqual([
      'folder',
      '.hidden',
      'file2',
      'file10'
    ])
    expect(result.hasMore).toBe(false)
    expect(fsReadFileChunk).not.toHaveBeenCalled()
  })

  it.each(['local', 'environment'])(
    'caps %s text reads at 1 MiB and reports a line beyond that budget',
    async (owner) => {
      setContent(`${'x'.repeat(1024 * 1024)}\nnot yet reachable`)
      const target = owner === 'local' ? fileTarget() : remoteTarget()
      target.line = 2
      expect(await loadTerminalFilePeek(target, new AbortController().signal)).toMatchObject({
        kind: 'notice',
        reason: 'line-out-of-range'
      })
      if (owner === 'local') {
        expect(fsReadFileChunk).toHaveBeenCalledTimes(16)
        expect(fsReadFileChunk).toHaveBeenLastCalledWith(
          expect.objectContaining({ offset: 983040, length: 65536 })
        )
      } else {
        expect(
          rpcCall.mock.calls.filter(([request]) => request.method === 'files.readChunk')
        ).toHaveLength(16)
        expect(rpcCall).toHaveBeenLastCalledWith(
          expect.objectContaining({
            method: 'files.readChunk',
            params: {
              worktree: 'id:folder:notes',
              relativePath: 'example.ts',
              offset: 983040,
              length: 65536
            }
          })
        )
        expect(fsReadFileChunk).not.toHaveBeenCalled()
      }
    }
  )

  it('stops after the first chunk once a distant centered window is complete', async () => {
    setContent(
      `${Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`).join('\n')}\n${'z'.repeat(100000)}`
    )
    const result = await loadTerminalFilePeek(
      fileTarget({ line: 25 }),
      new AbortController().signal
    )
    expect(result).toMatchObject({
      kind: 'text',
      firstLineNumber: 15,
      targetLine: 25
    })
    if (result?.kind !== 'text') {
      throw new Error('Expected text')
    }
    expect(result.lines).toHaveLength(20)
    expect(result.lines[0]).toBe('line 15')
    expect(result.lines.at(-1)).toBe('line 34')
    expect(fsReadFileChunk).toHaveBeenCalledTimes(1)
  })

  it('returns a line-out-of-range notice beyond EOF', async () => {
    setContent('one\ntwo')
    expect(
      await loadTerminalFilePeek(fileTarget({ line: 3 }), new AbortController().signal)
    ).toMatchObject({ kind: 'notice', reason: 'line-out-of-range' })
  })

  it('detects extensionless source language from the bounded file prefix', async () => {
    setContent('#!/usr/bin/env python3\nprint(42)')
    expect(
      await loadTerminalFilePeek(
        fileTarget({ absolutePath: '/workspace/script' }),
        new AbortController().signal
      )
    ).toMatchObject({ kind: 'text', language: 'python' })
  })

  it.each(['stat', 'range', 'directory', 'rpc'])(
    'returns an unreadable notice on a %s failure without a whole-file fallback',
    async (stage) => {
      if (stage === 'stat') {
        fsStat.mockRejectedValueOnce(new Error('denied'))
      }
      if (stage === 'range') {
        fsReadFileChunk.mockRejectedValueOnce(new Error('disappeared'))
      }
      if (stage === 'directory') {
        snapshot.isDirectory = true
        fsReadDir.mockRejectedValueOnce(new Error('denied'))
      }
      if (stage === 'rpc') {
        rpcCall.mockRejectedValueOnce(new Error('offline'))
      }
      expect(
        await loadTerminalFilePeek(
          stage === 'rpc' ? remoteTarget() : fileTarget(),
          new AbortController().signal
        )
      ).toMatchObject({ kind: 'notice', reason: 'unreadable' })
    }
  )

  it('caps an unpaged older host root listing without losing directories-first order', async () => {
    entries = [
      ...Array.from({ length: 20 }, (_, index) => ({
        name: `file${20 - index}`,
        isDirectory: false,
        isSymlink: false
      })),
      { name: 'folder', isDirectory: true, isSymlink: false }
    ]
    legacyDirectoryReply = entries
    const result = await loadTerminalFilePeek(
      remoteTarget('/workspace'),
      new AbortController().signal
    )
    expect(result?.kind).toBe('directory')
    if (result?.kind !== 'directory') {
      throw new Error('Expected directory')
    }
    expect(result.hasMore).toBe(true)
    expect(result.entries).toHaveLength(20)
    expect(result.entries[0].name).toBe('folder')
    expect(result.entries[1].name).toBe('file1')
    expect(result.entries.at(-1)?.name).toBe('file19')
    expect(rpcCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.readDir',
        params: { worktree: 'id:folder:notes', relativePath: '' }
      })
    )
    expect(fsStat).not.toHaveBeenCalled()
    expect(fsReadDir).not.toHaveBeenCalled()
  })

  it('refuses an already-aborted request without any filesystem work', async () => {
    const controller = new AbortController()
    const reason = { canceled: 'hover-left' }
    controller.abort(reason)
    await expect(loadTerminalFilePeek(fileTarget(), controller.signal)).rejects.toBe(reason)
    expect(fsStat).not.toHaveBeenCalled()
    expect(fsReadFileChunk).not.toHaveBeenCalled()
  })

  it('checks cancellation after stat before starting any range read', async () => {
    const controller = new AbortController()
    fsStat.mockImplementationOnce(async () => {
      controller.abort('canceled during stat')
      return snapshot
    })
    await expect(loadTerminalFilePeek(fileTarget(), controller.signal)).rejects.toBe(
      'canceled during stat'
    )
    expect(fsReadFileChunk).not.toHaveBeenCalled()
  })

  it('rejects a delayed range response after cancellation and never reads the next chunk', async () => {
    setContent(`${'x'.repeat(200000)}\nline two`)
    const started = Promise.withResolvers<void>()
    const response = Promise.withResolvers<ReturnType<typeof chunk>>()
    fsReadFileChunk.mockImplementationOnce(() => {
      started.resolve()
      return response.promise
    })
    const controller = new AbortController()
    const pending = loadTerminalFilePeek(fileTarget({ line: 2 }), controller.signal)
    await started.promise
    const reason = new Error('hover superseded')
    controller.abort(reason)
    response.resolve(chunk(0, 65536))
    await expect(pending).rejects.toBe(reason)
    expect(fsReadFileChunk).toHaveBeenCalledTimes(1)
  })

  it.each(['directory', 'markdown'])('checks cancellation after the %s read', async (kind) => {
    const controller = new AbortController()
    if (kind === 'directory') {
      snapshot.isDirectory = true
      fsReadDir.mockImplementationOnce(async () => {
        controller.abort('canceled directory')
        return []
      })
    } else {
      fsReadFileChunk.mockImplementationOnce(async ({ offset, length }) => {
        controller.abort('canceled markdown')
        return chunk(offset, length)
      })
    }
    const target = fileTarget({
      absolutePath: kind === 'markdown' ? '/workspace/readme.md' : '/workspace/folder'
    })
    await expect(loadTerminalFilePeek(target, controller.signal)).rejects.toBe(`canceled ${kind}`)
  })

  it('keeps explicit SSH ownership in local IPC and refuses a changed owner', async () => {
    const target = fileTarget()
    target.fileContext.connectionId = 'ssh-owner'
    target.fileContext.expectedExternalSshTargetId = 'ssh-owner'
    expect(await loadTerminalFilePeek(target, new AbortController().signal)).toMatchObject({
      kind: 'text'
    })
    expect(fsReadFileChunk).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-owner' })
    )
    fsStat.mockClear()
    fsReadFileChunk.mockClear()
    target.fileContext.connectionId = 'different-host'
    expect(await loadTerminalFilePeek(target, new AbortController().signal)).toMatchObject({
      kind: 'notice',
      reason: 'unreadable'
    })
    expect(fsStat).not.toHaveBeenCalled()
    expect(fsReadFileChunk).not.toHaveBeenCalled()
  })

  it('reads a folder-workspace text excerpt through bounded local IPC', async () => {
    const target = fileTarget()
    expect(await loadTerminalFilePeek(target, new AbortController().signal)).toEqual({
      kind: 'text',
      path: target.absolutePath,
      language: 'typescript',
      firstLineNumber: 1,
      targetLine: null,
      lines: ['const answer = 42', ''],
      truncatedLines: false
    })
    expect(fsReadFileChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/workspace/example.ts',
        offset: 0,
        length: bytes.length
      })
    )
  })
})
