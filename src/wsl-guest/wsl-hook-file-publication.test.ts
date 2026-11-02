import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { posix } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listRemoteDirectory,
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../main/agent-hooks/installer-utils-remote'
import { createWslHookSftpAdapter } from '../main/agent-hooks/wsl-hook-fs-adapter'
import { ClaudeHookService } from '../main/claude/hook-service'
import type { SshChannelMultiplexer } from '../main/ssh/ssh-channel-multiplexer'
import type { MethodHandler, RelayDispatcher } from './dispatcher'
import { WSL_HOOK_FS_METHODS } from '../shared/wsl-hook-relay-contract'
import { registerWslHookFsHandlers } from './wsl-hook-fs-bridge'

const rootCapture = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../main/claude/claude-hook-target', () => ({
  resolveSystemClaudeHookTarget: rootCapture.resolve
}))

const writers = [
  {
    name: 'JSON',
    write: (sftp, path, text) => writeHooksJsonRemote(sftp, path, {}, { serialized: text }),
    mode: 0o640
  },
  { name: 'script', write: writeManagedScriptRemote, mode: 0o755 },
  { name: 'text', write: writeTextFileRemoteAtomic, mode: 0o640 }
] satisfies { name: string; write: typeof writeTextFileRemoteAtomic; mode: number }[]

describe.skipIf(process.platform === 'win32')('remote physical file publication', () => {
  let base: string
  let home: string
  let logical: string
  let physical: string
  let handlers: Map<string, MethodHandler>
  let directoryCalls: number
  let names: number
  let nameBytes: number
  let legacy: boolean
  let calls: { method: string; params: Record<string, unknown> }[]

  const request = async (
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> => {
    calls.push({ method, params })
    if (legacy && method === WSL_HOOK_FS_METHODS.home) {
      return { ok: true, home }
    }
    if (
      legacy &&
      (method === WSL_HOOK_FS_METHODS.mkdir || method === WSL_HOOK_FS_METHODS.stat) &&
      typeof params.path === 'string' &&
      params.path !== home &&
      !params.path.startsWith(`${home}/`)
    ) {
      return { ok: false, errno: 'EACCES', message: 'old guest ancestor denied' }
    }
    const handler = handlers.get(method)
    if (!handler) {
      throw new Error(`unregistered method ${method}`)
    }
    const result = await handler(params, { clientId: 1, isStale: () => false })
    if (
      method === WSL_HOOK_FS_METHODS.readdir &&
      result &&
      typeof result === 'object' &&
      'entries' in result &&
      Array.isArray(result.entries)
    ) {
      names += result.entries.length
      nameBytes += Buffer.byteLength(JSON.stringify(result.entries))
    }
    return result
  }
  const adapter = (requirePhysical = false) => {
    return createWslHookSftpAdapter(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The adapter uses only request, routed to the registered production handlers.
      { request } as unknown as SshChannelMultiplexer,
      requirePhysical
    )
  }
  beforeEach(async () => {
    base = await fs.realpath(await fs.mkdtemp(posix.join(tmpdir(), 'pr31199-publication-')))
    home = posix.join(base, 'home')
    logical = posix.join(base, 'logical')
    physical = posix.join(base, 'physical')
    await Promise.all([home, logical, physical].map((path) => fs.mkdir(path)))
    rootCapture.resolve.mockResolvedValue({ kind: 'system-default', configDir: logical })
    handlers = new Map()
    registerWslHookFsHandlers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Registration only uses onRequest; calls run the actual registered handlers.
      {
        onRequest: (method: string, handler: MethodHandler) => handlers.set(method, handler)
      } as unknown as RelayDispatcher,
      home
    )
    legacy = false
    calls = []
    directoryCalls = names = nameBytes = 0
    const mkdir = fs.mkdir.bind(fs)
    vi.spyOn(fs, 'mkdir').mockImplementation((...args) => {
      directoryCalls += 1
      return mkdir(...args)
    })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(base, { recursive: true, force: true })
  })

  it.each(writers)(
    'publishes $name beside the physical target without replacing its link',
    async ({ write, mode }) => {
      const target = posix.join(physical, 'custom-name')
      const link = posix.join(logical, 'settings.json')
      await fs.writeFile(target, 'old', { mode: 0o640 })
      await fs.symlink(target, link)
      const renameFile = fs.rename.bind(fs)
      const rename = vi.spyOn(fs, 'rename').mockImplementation((source, destination) => {
        if (posix.dirname(String(source)) !== posix.dirname(String(destination))) {
          throw Object.assign(new Error('cross-mount staging'), { code: 'EXDEV' })
        }
        return renameFile(source, destination)
      })
      const sftp = adapter()
      await write(sftp, link, 'complete new bytes')
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
      expect(await fs.readFile(target, 'utf8')).toBe('complete new bytes')
      expect((await fs.stat(target)).mode & 0o7777).toBe(mode)
      const [source, destination] = rename.mock.calls[0] ?? []
      expect(posix.dirname(String(source))).toBe(physical)
      expect(destination).toBe(target)
      expect(
        await request(WSL_HOOK_FS_METHODS.writeFile, {
          path: target,
          content: 'forbidden',
          physicalAtomic: true
        })
      ).toMatchObject({ ok: false, errno: 'EACCES' })
      expect(await request(WSL_HOOK_FS_METHODS.stat, { path: target })).toMatchObject({
        ok: false,
        errno: 'EACCES'
      })
      expect(await fs.readdir(physical)).toEqual(['custom-name'])
      const inode = (await fs.stat(target)).ino
      if (mode === 0o755) {
        await fs.chmod(target, 0o600)
      }
      await write(sftp, link, 'complete new bytes')
      expect((await fs.stat(target)).ino).toBe(inode)
      expect((await fs.stat(target)).mode & 0o7777).toBe(mode)
      expect(rename).toHaveBeenCalledTimes(1)
    }
  )

  it.each(writers.flatMap((writer) => [false, true].map((old) => ({ ...writer, old }))))(
    'bounds $name preparation at N/10N (legacy=$old)',
    async ({ write, old }) => {
      legacy = old
      if (old) {
        logical = posix.join(home, '.claude')
      }
      await fs.mkdir(logical, { recursive: true })
      const sftp = adapter()
      const directoryRead = vi.spyOn(fs, 'readdir')
      const metadata = vi.spyOn(fs, 'stat')
      const counts: {
        directoryCalls: number
        names: number
        nameBytes: number
        metadata: number
      }[] = []
      for (const population of [100, 1000]) {
        await Promise.all(
          Array.from({ length: population }, (_, i) =>
            fs.writeFile(posix.join(base, `sibling-${i}`), '')
          )
        )
        const path = posix.join(logical, `missing-${population}`, 'file')
        directoryCalls = names = nameBytes = 0
        directoryRead.mockClear()
        metadata.mockClear()
        await write(sftp, path, 'first')
        await write(sftp, path, 'changed')
        await write(sftp, path, 'changed')
        names = (await Promise.all(directoryRead.mock.results.map(({ value }) => value))).reduce(
          (total, entries) => total + entries.length,
          0
        )
        counts.push({ directoryCalls, names, nameBytes, metadata: metadata.mock.calls.length })
        expect(await fs.readFile(path, 'utf8')).toBe('changed')
        expect(names).toBe(0)
        expect(nameBytes).toBe(0)
        expect(directoryCalls).toBe(2)
        expect(metadata.mock.calls.length).toBeLessThanOrEqual(old ? 3 : 2)
      }
      expect(counts[1]).toEqual(counts[0])
      expect(
        calls.filter(
          ({ method, params }) =>
            method === WSL_HOOK_FS_METHODS.mkdir &&
            typeof params.path === 'string' &&
            posix.relative(home, params.path).startsWith('..')
        )
      ).toEqual([])
      expect(await listRemoteDirectory(sftp, logical)).toEqual(
        expect.arrayContaining(['missing-100', 'missing-1000'])
      )
    }
  )

  it.each([false, true])(
    'requires only physical-parent write permission (denyPhysical=%s)',
    async (denyPhysical) => {
      const path = posix.join(logical, 'settings.json')
      const target = posix.join(physical, 'custom.json')
      await fs.writeFile(target, 'old')
      await fs.symlink(target, path)
      const open = fs.open.bind(fs)
      const deniedParent = denyPhysical ? physical : logical
      const opened: string[] = []
      vi.spyOn(fs, 'open').mockImplementation((name, ...args) => {
        opened.push(String(name))
        if (posix.dirname(String(name)) === deniedParent) {
          throw Object.assign(new Error('readonly parent'), { code: 'EROFS' })
        }
        return open(name, ...args)
      })
      const result = writeTextFileRemoteAtomic(adapter(), path, 'new')
      await (denyPhysical ? expect(result).rejects.toThrow('readonly parent') : result)
      expect((await fs.lstat(path)).isSymbolicLink()).toBe(true)
      expect(await fs.readFile(target, 'utf8')).toBe(denyPhysical ? 'old' : 'new')
      expect(opened.every((name) => posix.dirname(name) === physical)).toBe(true)
      expect(await fs.readdir(physical)).toEqual(['custom.json'])
    }
  )

  it.each(['write', 'chmod', 'rename'] as const)(
    'keeps live bytes and cleans an owned temporary on %s failure',
    async (stage) => {
      const path = posix.join(logical, 'settings.json')
      await fs.writeFile(path, 'old')
      const failure = Object.assign(new Error(`failed ${stage}`), { code: 'EACCES' })
      if (stage === 'write') {
        const open = fs.open.bind(fs)
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await open(...args)
          vi.spyOn(handle, 'writeFile').mockRejectedValue(failure)
          return handle
        })
      } else {
        vi.spyOn(fs, stage).mockRejectedValue(failure)
      }
      await expect(writeTextFileRemoteAtomic(adapter(), path, 'new')).rejects.toThrow(
        failure.message
      )
      expect(await fs.readFile(path, 'utf8')).toBe('old')
      expect(await fs.readdir(logical)).toEqual(['settings.json'])
    }
  )

  it('keeps directory links, claims dangling names, and preserves actual JSON read/parse refusal', async () => {
    const directoryLink = posix.join(logical, 'directory')
    await fs.symlink(physical, directoryLink)
    const file = posix.join(directoryLink, 'new.json')
    const sftp = adapter()
    await writeHooksJsonRemote(sftp, file, { user: true })
    expect((await fs.lstat(directoryLink)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await fs.readFile(posix.join(physical, 'new.json'), 'utf8'))).toEqual({
      user: true
    })
    const dangling = posix.join(logical, 'dangling')
    await fs.symlink(posix.join(physical, 'absent'), dangling)
    expect(await readHooksJsonRemote(sftp, dangling)).toEqual({})
    await writeHooksJsonRemote(sftp, dangling, { user: true })
    expect((await fs.lstat(dangling)).isFile()).toBe(true)
    await expect(fs.stat(posix.join(physical, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
    const cycle = posix.join(logical, 'cycle')
    await fs.symlink(cycle, cycle)
    await expect(readHooksJsonRemote(sftp, cycle)).rejects.toThrow()
    expect((await fs.lstat(cycle)).isSymbolicLink()).toBe(true)
    await writeManagedScriptRemote(sftp, cycle, 'executable')
    expect((await fs.lstat(cycle)).isFile()).toBe(true)
    const invalid = posix.join(logical, 'invalid')
    await fs.writeFile(invalid, '{broken')
    expect(await readHooksJsonRemote(sftp, invalid)).toBeNull()
    expect(await fs.readFile(invalid, 'utf8')).toBe('{broken')
  })

  it('requires positive capability on this connection and never falls back after a lost write reply', async () => {
    const path = posix.join(logical, 'settings.json')
    const sftp = adapter(true)
    await writeTextFileRemoteAtomic(sftp, path, 'first')
    for (const capability of [undefined, false, 'true']) {
      const uncertain = async (method: string, params?: Record<string, unknown>) =>
        method === WSL_HOOK_FS_METHODS.home
          ? {
              ok: true,
              home,
              ...(capability === undefined ? {} : { physicalAtomicWrite: capability })
            }
          : request(method, params)
      const stale = createWslHookSftpAdapter(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only request is used by the facade.
        { request: uncertain } as unknown as SshChannelMultiplexer,
        true
      )
      calls = []
      await expect(writeTextFileRemoteAtomic(stale, path, 'wrong')).rejects.toThrow(
        'does not support'
      )
      expect(calls).toEqual([])
    }
    const dropped = async (method: string, params?: Record<string, unknown>) => {
      const result = await request(method, params)
      if (method === WSL_HOOK_FS_METHODS.writeFile) {
        throw new Error('reply lost')
      }
      return result
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only request is used; this fixture drops the response after the actual handler completes.
    const unknown = createWslHookSftpAdapter({
      request: dropped
    } as unknown as SshChannelMultiplexer)
    calls = []
    await expect(writeTextFileRemoteAtomic(unknown, path, 'complete')).rejects.toThrow('reply lost')
    expect(calls.map(({ method }) => method)).toEqual([
      WSL_HOOK_FS_METHODS.home,
      WSL_HOOK_FS_METHODS.writeFile
    ])
    expect(await fs.readFile(path, 'utf8')).toBe('complete')
    await writeTextFileRemoteAtomic(adapter(), path, 'complete')
  })

  it('keeps old ordinary writes and literal rename source-consumption semantics', async () => {
    const source = posix.join(logical, 'source')
    const destination = posix.join(logical, 'destination')
    const target = posix.join(physical, 'target')
    await fs.writeFile(target, 'old')
    await fs.symlink(target, destination)
    expect(
      await request(WSL_HOOK_FS_METHODS.writeFile, { path: destination, content: 'direct' })
    ).toEqual({ ok: true })
    expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('direct')
    await fs.writeFile(source, 'rename')
    expect(await request(WSL_HOOK_FS_METHODS.rename, { src: source, dst: destination })).toEqual({
      ok: true
    })
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.lstat(destination)).isFile()).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('direct')
  })

  it('retains service parse refusal and foreign settings through the physical publisher', async () => {
    const target = posix.join(physical, 'user.json')
    const path = posix.join(logical, 'settings.json')
    const sftp = adapter()
    const service = new ClaudeHookService()
    await fs.writeFile(target, '{broken')
    await fs.symlink(target, path)
    expect((await service.installRemote(sftp, home, { configDir: logical })).state).toBe('error')
    expect(await fs.readdir(home)).toEqual([])
    expect(await fs.readFile(target, 'utf8')).toBe('{broken')
    const userHook = { hooks: [{ type: 'command', command: 'printf user-hook' }] }
    await fs.writeFile(target, JSON.stringify({ model: 'opus', hooks: { Stop: [userHook] } }))
    expect((await service.installRemote(sftp, home, { configDir: logical })).state).toBe(
      'installed'
    )
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true)
    const settings = JSON.parse(await fs.readFile(target, 'utf8'))
    expect(settings.model).toBe('opus')
    expect(settings.hooks.Stop).toContainEqual(userHook)
    expect(settings.statusLine).toBeUndefined()
    expect(
      await fs.readFile(posix.join(home, '.orca/agent-hooks/claude-hook.sh'), 'utf8')
    ).toContain('/hook/claude')
  })
})
