// Install hook files through guest stdio RPCs instead of spawning wsl.exe per file.
import { promises as fs } from 'node:fs'
import { posix } from 'node:path'

import type { RelayDispatcher } from './dispatcher'
import {
  WSL_HOOK_FS_METHODS,
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
  // Scope host-owned stdio operations lexically to the guest home; symlinks within home are intentionally followed.
  const homeRoot = posix.resolve(home)
  const resolveRaw = (rawPath: unknown): string => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw Object.assign(new Error('invalid path'), { code: 'EINVAL' })
    }
    return posix.resolve(rawPath)
  }
  const scoped = (rawPath: unknown): string => {
    const resolved = resolveRaw(rawPath)
    if (resolved !== homeRoot && !resolved.startsWith(`${homeRoot}/`)) {
      throw Object.assign(new Error(`path outside home: ${resolved}`), { code: 'EACCES' })
    }
    return resolved
  }
  // Allow read-only ancestor probes for installer mkdir-p walks from /; keep all writes home-scoped.
  const scopedProbe = (rawPath: unknown): string => {
    const resolved = resolveRaw(rawPath)
    if (resolved === '/' || homeRoot === resolved || homeRoot.startsWith(`${resolved}/`)) {
      return resolved
    }
    return scoped(rawPath)
  }

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.home,
    async (): Promise<WslFsResult<{ home: string }>> => {
      return { ok: true, home: homeRoot, ...linkStatus?.() }
    }
  )

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.readFile,
    async (params): Promise<WslFsResult<{ content: string }>> => {
      try {
        const content = await fs.readFile(scoped(params.path), 'utf8')
        return { ok: true, content }
      } catch (err) {
        return failure(err)
      }
    }
  )

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.writeFile, async (params): Promise<WslFsResult> => {
    try {
      const mode = typeof params.mode === 'number' ? params.mode : undefined
      await fs.writeFile(scoped(params.path), String(params.content ?? ''), {
        encoding: 'utf8',
        mode
      })
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.stat,
    async (params): Promise<WslFsResult<{ mode: number }>> => {
      try {
        const stats = await fs.stat(scoped(params.path))
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
      await fs.rename(scoped(params.src), scoped(params.dst))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.unlink, async (params): Promise<WslFsResult> => {
    try {
      await fs.unlink(scoped(params.path))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.chmod, async (params): Promise<WslFsResult> => {
    try {
      await fs.chmod(scoped(params.path), Number(params.mode))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })

  dispatcher.onRequest(
    WSL_HOOK_FS_METHODS.readdir,
    async (params): Promise<WslFsResult<{ entries: { filename: string }[] }>> => {
      try {
        const names = await fs.readdir(scopedProbe(params.path))
        return { ok: true, entries: names.map((filename) => ({ filename })) }
      } catch (err) {
        return failure(err)
      }
    }
  )

  dispatcher.onRequest(WSL_HOOK_FS_METHODS.mkdir, async (params): Promise<WslFsResult> => {
    try {
      await fs.mkdir(scoped(params.path))
      return { ok: true }
    } catch (err) {
      return failure(err)
    }
  })
}
