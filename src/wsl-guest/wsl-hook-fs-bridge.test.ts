// POSIX guest paths cannot resolve Windows temp roots; run this Linux-only bridge suite off Windows.
import { mkdtempSync, promises as fs, rmSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rootCapture = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../main/claude/claude-hook-target', () => ({
  resolveSystemClaudeHookTarget: rootCapture.resolve
}))

import { registerWslHookFsHandlers } from './wsl-hook-fs-bridge'
import { createWslHookSftpAdapter } from '../main/agent-hooks/wsl-hook-fs-adapter'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote
} from '../main/agent-hooks/installer-utils-remote'
import type { SshChannelMultiplexer } from '../main/ssh/ssh-channel-multiplexer'
import type { MethodHandler, RelayDispatcher, RequestContext } from './dispatcher'
import { WSL_HOOK_FS_METHODS, type WslFsResult } from '../shared/wsl-hook-relay-contract'

describe.skipIf(process.platform === 'win32')('registerWslHookFsHandlers (WSL fs bridge)', () => {
  let home: string
  let handlers: Map<string, MethodHandler>
  const context: RequestContext = { clientId: 1, isStale: () => false }

  const call = async <T extends object = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<WslFsResult<T>> => {
    const handler = handlers.get(method)
    if (!handler) {
      throw new Error(`no handler registered for ${method}`)
    }
    return (await handler(params, context)) as WslFsResult<T>
  }

  const register = (guestHome: string): void => {
    handlers = new Map<string, MethodHandler>()
    // Registration needs only onRequest; capture handlers without starting a real dispatcher.
    const dispatcher = {
      onRequest: (method: string, handler: MethodHandler) => {
        handlers.set(method, handler)
      }
    } as unknown as RelayDispatcher
    registerWslHookFsHandlers(dispatcher, guestHome, () => ({ fallbackPort: 4321 }))
  }

  beforeEach(() => {
    home = mkdtempSync(posix.join(tmpdir(), 'wsl-fs-home-'))
    rootCapture.resolve.mockResolvedValue({
      kind: 'system-default',
      configDir: posix.join(home, '.claude')
    })
    register(home)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  })

  it('installs settings into a missing nested custom root outside HOME', async () => {
    const parent = mkdtempSync(posix.join(tmpdir(), 'wsl-fs-parent-'))
    const custom = posix.join(parent, 'missing-parent', 'claude')
    rootCapture.resolve.mockResolvedValue({ kind: 'system-default', configDir: custom })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The adapter only uses request, routed here to the real guest handlers.
    const mux = { request: call } as unknown as SshChannelMultiplexer
    try {
      const path = posix.join(custom, 'settings.json')
      await writeHooksJsonRemote(createWslHookSftpAdapter(mux), path, { model: 'opus' })
      expect(await call(WSL_HOOK_FS_METHODS.readFile, { path })).toEqual({
        ok: true,
        content: expect.stringContaining('"opus"')
      })
      expect(
        await call(WSL_HOOK_FS_METHODS.writeFile, {
          path: posix.join(parent, 'missing-parent', 'outside.txt'),
          content: 'x'
        })
      ).toMatchObject({ ok: false, errno: 'EACCES' })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('atomically installs and reads settings outside HOME when the guest root is /', async () => {
    const parent = mkdtempSync(posix.join(tmpdir(), 'wsl-fs-root-'))
    const custom = posix.join(parent, 'missing')
    const path = posix.join(custom, 'settings.json')
    rootCapture.resolve.mockResolvedValue({ kind: 'system-default', configDir: '/' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only request is used, forwarded to the production guest handlers.
    const mux = { request: call } as unknown as SshChannelMultiplexer
    const sftp = createWslHookSftpAdapter(mux)
    const open = vi.spyOn(fs, 'open')
    const rename = vi.spyOn(fs, 'rename')
    const unlink = vi.spyOn(fs, 'unlink')
    const chmod = vi.spyOn(fs, 'chmod')
    const stat = vi.spyOn(fs, 'stat')
    const mkdir = vi.spyOn(fs, 'mkdir')
    try {
      expect(await readHooksJsonRemote(sftp, path)).toEqual({})
      const settings = { model: 'opus', permissions: { allow: ['Read'] } }
      await writeHooksJsonRemote(sftp, path, settings)
      expect(await readHooksJsonRemote(sftp, path)).toEqual(settings)
      expect(mkdir).toHaveBeenCalledWith(custom, { recursive: true })
      expect(statSync(path).mode & 0o777).toBe(0o600)
      const temporary = open.mock.calls[0]?.[0]
      expect(typeof temporary).toBe('string')
      expect(temporary).toEqual(expect.stringMatching(/\/missing\/\.[^/]+\.tmp$/))
      expect(stat).toHaveBeenCalledWith(path)
      expect(chmod).toHaveBeenCalledWith(temporary, 0o600)
      expect(rename).toHaveBeenCalledExactlyOnceWith(temporary, path)
      expect(unlink).toHaveBeenCalledExactlyOnceWith(temporary)
      await writeHooksJsonRemote(sftp, path, settings)
      expect(open).toHaveBeenCalledExactlyOnceWith(temporary, 'wx', 0o600)
      expect(rename).toHaveBeenCalledTimes(1)
      expect(unlink).toHaveBeenCalledTimes(1)
    } finally {
      vi.restoreAllMocks()
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('normalizes every filesystem operand and limits ancestor access to directories', async () => {
    const denied = Object.assign(new Error('synthetic filesystem permission denied'), {
      code: 'EACCES'
    })
    const operations = [
      [WSL_HOOK_FS_METHODS.readFile, vi.spyOn(fs, 'readFile'), ['utf8'], false],
      [
        WSL_HOOK_FS_METHODS.writeFile,
        vi.spyOn(fs, 'writeFile'),
        ['{}', { encoding: 'utf8', mode: 0o600 }],
        false
      ],
      [WSL_HOOK_FS_METHODS.stat, vi.spyOn(fs, 'stat'), [], false],
      [WSL_HOOK_FS_METHODS.unlink, vi.spyOn(fs, 'unlink'), [], false],
      [WSL_HOOK_FS_METHODS.chmod, vi.spyOn(fs, 'chmod'), [0o600], false],
      [WSL_HOOK_FS_METHODS.readdir, vi.spyOn(fs, 'readdir'), [], true],
      [WSL_HOOK_FS_METHODS.mkdir, vi.spyOn(fs, 'mkdir'), [], true]
    ] as const
    for (const [, spy] of operations) {
      spy.mockRejectedValue(denied)
    }
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(denied)
    const cases = [
      ['///', '/home/synthetic', '/', '/', true, true],
      ['/', '/home/synthetic', '//settings.json', '/settings.json', true, true],
      ['/', '/home/synthetic', '//.publish.tmp', '/.publish.tmp', true, true],
      ['/opt/./claude///', '/home/synthetic', '/opt/claude//./', '/opt/claude', true, true],
      [
        '/opt/claude',
        '/home/synthetic',
        '/opt//claude/a/../settings.json',
        '/opt/claude/settings.json',
        true,
        true
      ],
      ['/opt/claude', '///', '/elsewhere/./file', '/elsewhere/file', true, true],
      [
        '/opt/claude',
        '/home/synthetic',
        '/opt/claude-other/file',
        '/opt/claude-other/file',
        false,
        false
      ],
      ['/opt/claude', '/home/synthetic', '/opt/claude/../outside', '/opt/outside', false, false],
      ['/opt/claude', '/home/synthetic', '/opt/./', '/opt', false, true],
      ['/opt/claude', '/home/synthetic', '/', '/', false, true]
    ] as const
    for (const [root, guestHome, path, normalized, strict, directory] of cases) {
      rootCapture.resolve.mockResolvedValue({ kind: 'system-default', configDir: root })
      register(guestHome)
      for (const [method, spy, args, allowAncestors] of operations) {
        spy.mockClear()
        const result = await call(method, { path, content: '{}', mode: 0o600 })
        expect(result).toMatchObject({ ok: false, errno: 'EACCES' })
        if (allowAncestors ? directory : strict) {
          expect(spy).toHaveBeenCalledExactlyOnceWith(normalized, ...args)
          expect(result).toMatchObject({ message: denied.message })
        } else {
          expect(spy).not.toHaveBeenCalled()
        }
      }
      for (const [src, dst] of [
        [path, '/home/synthetic/next'],
        ['/home/synthetic/next', path]
      ]) {
        rename.mockClear()
        expect(await call(WSL_HOOK_FS_METHODS.rename, { src, dst })).toMatchObject({
          ok: false,
          errno: 'EACCES'
        })
        if (strict) {
          expect(rename).toHaveBeenCalledExactlyOnceWith(posix.resolve(src), posix.resolve(dst))
        } else {
          expect(rename).not.toHaveBeenCalled()
        }
      }
    }
  })

  it('awaits the guest-derived custom root before allowing atomic writes outside HOME', async () => {
    const custom = mkdtempSync(posix.join(tmpdir(), 'wsl-fs-custom-'))
    let resolveCapture!: (value: { kind: 'system-default'; configDir: string }) => void
    rootCapture.resolve.mockReturnValue(
      new Promise((resolve) => {
        resolveCapture = resolve
      })
    )
    try {
      const path = posix.join(custom, 'settings.json')
      let finished = false
      const pending = call(WSL_HOOK_FS_METHODS.writeFile, {
        path: `${path}.tmp`,
        content: '{}'
      }).then((value) => {
        finished = true
        return value
      })
      await Promise.resolve()
      expect(finished).toBe(false)
      resolveCapture({ kind: 'system-default', configDir: custom })
      expect(await pending).toEqual({ ok: true })
      expect(await call(WSL_HOOK_FS_METHODS.rename, { src: `${path}.tmp`, dst: path })).toEqual({
        ok: true
      })
      expect(await call(WSL_HOOK_FS_METHODS.readFile, { path })).toEqual({
        ok: true,
        content: '{}'
      })
      expect((await call(WSL_HOOK_FS_METHODS.stat, { path })).ok).toBe(true)
      expect((await call(WSL_HOOK_FS_METHODS.chmod, { path, mode: 0o600 })).ok).toBe(true)
      expect((await call(WSL_HOOK_FS_METHODS.readdir, { path: posix.dirname(custom) })).ok).toBe(
        true
      )
      expect(
        await call(WSL_HOOK_FS_METHODS.rename, { src: path, dst: `${custom}-other/settings.json` })
      ).toMatchObject({ ok: false, errno: 'EACCES' })
      expect(await call(WSL_HOOK_FS_METHODS.mkdir, { path: `${custom}-other` })).toMatchObject({
        ok: false,
        errno: 'EACCES'
      })
      expect((await call(WSL_HOOK_FS_METHODS.unlink, { path })).ok).toBe(true)
    } finally {
      rmSync(custom, { recursive: true, force: true })
    }
  })

  it('returns the resolved home and merges linkStatus extras', async () => {
    const result = await call<{ home: string; fallbackPort: number }>(WSL_HOOK_FS_METHODS.home)
    expect(result).toMatchObject({ ok: true, home: posix.resolve(home), fallbackPort: 4321 })
  })

  it('round-trips writeFile + readFile inside home', async () => {
    const path = posix.join(home, 'note.txt')
    const write = await call(WSL_HOOK_FS_METHODS.writeFile, { path, content: 'hello guest' })
    expect(write.ok).toBe(true)
    const read = await call<{ content: string }>(WSL_HOOK_FS_METHODS.readFile, { path })
    expect(read).toEqual({ ok: true, content: 'hello guest' })
  })

  it('refuses writeFile to an absolute path outside home', async () => {
    const result = await call(WSL_HOOK_FS_METHODS.writeFile, {
      path: '/etc/orca-evil.txt',
      content: 'x'
    })
    expect(result).toMatchObject({ ok: false, errno: 'EACCES' })
  })

  it('refuses a `..` traversal that escapes home', async () => {
    const result = await call(WSL_HOOK_FS_METHODS.writeFile, {
      path: `${home}/../escape.txt`,
      content: 'x'
    })
    expect(result).toMatchObject({ ok: false, errno: 'EACCES' })
  })

  it('refuses a sibling dir that shares home as a string prefix', async () => {
    // `${home}-evil/x` starts with homeRoot but not with `${homeRoot}/`.
    const result = await call(WSL_HOOK_FS_METHODS.writeFile, {
      path: `${home}-evil/x.txt`,
      content: 'x'
    })
    expect(result).toMatchObject({ ok: false, errno: 'EACCES' })
  })

  it('reports ENOENT for a missing file inside home', async () => {
    const result = await call(WSL_HOOK_FS_METHODS.readFile, {
      path: posix.join(home, 'does-not-exist.txt')
    })
    expect(result).toMatchObject({ ok: false, errno: 'ENOENT' })
  })

  it('allows readdir existence probes on an ancestor of home and on /', async () => {
    const ancestor = await call<{ entries: { filename: string }[] }>(WSL_HOOK_FS_METHODS.readdir, {
      path: posix.dirname(home)
    })
    expect(ancestor.ok).toBe(true)
    const root = await call<{ entries: { filename: string }[] }>(WSL_HOOK_FS_METHODS.readdir, {
      path: '/'
    })
    expect(root.ok).toBe(true)
  })

  it('refuses readdir on a non-ancestor dir outside home', async () => {
    const result = await call(WSL_HOOK_FS_METHODS.readdir, { path: '/etc' })
    expect(result).toMatchObject({ ok: false, errno: 'EACCES' })
  })

  it('refuses rename crossing the home boundary in either direction', async () => {
    const inside = posix.join(home, 'src.txt')
    await call(WSL_HOOK_FS_METHODS.writeFile, { path: inside, content: 'x' })
    const outbound = await call(WSL_HOOK_FS_METHODS.rename, {
      src: inside,
      dst: '/etc/orca-evil.txt'
    })
    expect(outbound).toMatchObject({ ok: false, errno: 'EACCES' })
    const inbound = await call(WSL_HOOK_FS_METHODS.rename, {
      src: '/etc/passwd',
      dst: posix.join(home, 'stolen.txt')
    })
    expect(inbound).toMatchObject({ ok: false, errno: 'EACCES' })
  })

  it('refuses a relative path (resolved against cwd, which lands outside home)', async () => {
    const result = await call(WSL_HOOK_FS_METHODS.readFile, { path: 'foo.txt' })
    expect(result).toMatchObject({ ok: false, errno: 'EACCES' })
  })

  it('refuses mkdir outside home and creates a dir inside home', async () => {
    const outside = await call(WSL_HOOK_FS_METHODS.mkdir, { path: '/etc/orca-evil-dir' })
    expect(outside).toMatchObject({ ok: false, errno: 'EACCES' })
    const dir = posix.join(home, 'newdir')
    const inside = await call(WSL_HOOK_FS_METHODS.mkdir, { path: dir })
    expect(inside.ok).toBe(true)
    expect(statSync(dir).isDirectory()).toBe(true)
  })

  it('fails without crashing when chmod gets a non-numeric mode', async () => {
    const path = posix.join(home, 'perm.txt')
    await call(WSL_HOOK_FS_METHODS.writeFile, { path, content: 'x' })
    const result = await call(WSL_HOOK_FS_METHODS.chmod, { path, mode: 'not-a-number' })
    expect(result.ok).toBe(false)
  })
})
