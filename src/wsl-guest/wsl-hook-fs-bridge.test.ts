// POSIX guest paths cannot resolve Windows temp roots; run this Linux-only bridge suite off Windows.
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registerWslHookFsHandlers } from './wsl-hook-fs-bridge'
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

  beforeEach(() => {
    home = mkdtempSync(posix.join(tmpdir(), 'wsl-fs-home-'))
    handlers = new Map<string, MethodHandler>()
    // Registration needs only onRequest; capture handlers without starting a real dispatcher.
    const dispatcher = {
      onRequest: (method: string, handler: MethodHandler) => {
        handlers.set(method, handler)
      }
    } as unknown as RelayDispatcher
    registerWslHookFsHandlers(dispatcher, home, () => ({ fallbackPort: 4321 }))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('round-trips writeFile + readFile inside home', async () => {
    const path = posix.join(home, 'note.txt')
    const write = await call(WSL_HOOK_FS_METHODS.writeFile, { path, content: 'hello guest' })
    expect(write.ok).toBe(true)
    const read = await call<{ content: string }>(WSL_HOOK_FS_METHODS.readFile, { path })
    expect(read).toEqual({ ok: true, content: 'hello guest' })
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

  it('refuses mkdir outside home and creates a dir inside home', async () => {
    const outside = await call(WSL_HOOK_FS_METHODS.mkdir, { path: '/etc/orca-evil-dir' })
    expect(outside).toMatchObject({ ok: false, errno: 'EACCES' })
    const dir = posix.join(home, 'newdir')
    const inside = await call(WSL_HOOK_FS_METHODS.mkdir, { path: dir })
    expect(inside.ok).toBe(true)
    expect(statSync(dir).isDirectory()).toBe(true)
  })
})
