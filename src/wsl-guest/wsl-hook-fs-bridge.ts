// Install hook files through guest stdio RPCs instead of spawning wsl.exe per file.
import { resolveSystemClaudeHookTarget } from '../main/claude/claude-hook-target'
import { promises as fs } from 'node:fs'
import { posix } from 'node:path'
import { writeHookFileAtomically } from './hook-file-atomic-write'

import type { RelayDispatcher } from './dispatcher'
import {
  WSL_HOOK_FS_METHODS,
  type WslHookFsHome,
  type WslFsFailure,
  type WslFsResult
} from '../shared/wsl-hook-relay-contract'

function failure(err: unknown): WslFsFailure {
  const e = err as NodeJS.ErrnoException
  return { ok: false, errno: e?.code ?? 'EUNKNOWN', message: e?.message ?? String(err) }
}

export function registerWslHookFsHandlers(
  dispatcher: RelayDispatcher,
  home: string,
  // Why: the home request doubles as the connect handshake; link diagnostics
  // (port fallback) ride it so the host can breadcrumb them.
  linkStatus?: () => Record<string, unknown>
): void {
  // The guest derives the only extra root; a caller cannot expand this scope.
  // Like HOME, this boundary is lexical on the trusted host-owned stdio channel.
  const homeRoot = posix.resolve(home)
  const resolveRaw = (rawPath: unknown): string => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw Object.assign(new Error('invalid path'), { code: 'EINVAL' })
    }
    return posix.resolve(rawPath)
  }
  const contains = (root: string, path: string): boolean => {
    const suffix = posix.relative(root, path)
    return suffix !== '..' && !suffix.startsWith('../') && !posix.isAbsolute(suffix)
  }
  const scoped = async (rawPath: unknown, allowAncestors = false): Promise<string> => {
    const resolved = resolveRaw(rawPath)
    if (contains(homeRoot, resolved) || (allowAncestors && contains(resolved, homeRoot))) {
      return resolved
    }
    const target = await resolveSystemClaudeHookTarget()
    const root = posix.resolve(target.configDir)
    if (contains(root, resolved) || (allowAncestors && contains(resolved, root))) {
      return resolved
    }
    throw Object.assign(new Error(`path outside hook roots: ${resolved}`), { code: 'EACCES' })
  }

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.home, async (): Promise<WslFsResult<WslHookFsHome>> => {
    return { ok: true, home: homeRoot, ...linkStatus?.(), physicalAtomicWrite: true }
  })

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.readFile,
    async (params): Promise<WslFsResult<{ content: string }>> => {
      try {
        const content = await fs.readFile(await scoped(params.path), 'utf8')
        return { ok: true, content }
      } catch (err) {
        return failure(err)
      }
    }
  )

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.writeFile, async (params): Promise<WslFsResult> => {
    try {
      const mode = typeof params.mode === 'number' ? params.mode : undefined
      const path = await scoped(params.path)
      const content = String(params.content ?? '')
      await (params.physicalAtomic === true
        ? writeHookFileAtomically(path, content, mode)
        : fs.writeFile(path, content, { encoding: 'utf8', mode }))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.stat,
    async (params): Promise<WslFsResult<{ mode: number }>> => {
      try {
        const stats = await fs.stat(await scoped(params.path))
        return { ok: true, mode: stats.mode }
      } catch (err) {
        return failure(err)
      }
    }
  )

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.rename, async (params): Promise<WslFsResult> => {
    try {
      // Why: POSIX rename overwrites atomically — exactly the OpenSSH
      // overwrite-rename semantics the installers prefer.
      await fs.rename(await scoped(params.src), await scoped(params.dst))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.unlink, async (params): Promise<WslFsResult> => {
    try {
      await fs.unlink(await scoped(params.path))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.chmod, async (params): Promise<WslFsResult> => {
    try {
      await fs.chmod(await scoped(params.path), Number(params.mode))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.readdir,
    async (params): Promise<WslFsResult<{ entries: { filename: string }[] }>> => {
      try {
        const names = await fs.readdir(await scoped(params.path, true))
        return { ok: true, entries: names.map((filename) => ({ filename })) }
      } catch (err) {
        return failure(err)
      }
    }
  )

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.mkdir, async (params): Promise<WslFsResult> => {
    try {
      // The shared installer creates missing parents on the way to a scoped root.
      await fs.mkdir(await scoped(params.path, true))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })
}
