import type { RuntimeFileListResult } from '../../../shared/runtime-types'
import {
  buildExcludePathPrefixes,
  shouldExcludeQuickOpenRelPath
} from '../../../shared/quick-open-filter'
import { QuickOpenPathRanker } from '../../../shared/quick-open-path-search'
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

const CACHE_LIMIT = 8
const CACHE_TTL_MS = 30_000

type EnvironmentTarget = Extract<RuntimeClientTarget, { kind: 'environment' }>
type CacheEntry = {
  expiresAt: number
  load: Promise<RuntimeFileListResult>
  controller: AbortController
  activeConsumers: number
  settled: boolean
}

const inventoryCache = new Map<string, CacheEntry>()

function cacheKey(
  target: EnvironmentTarget,
  worktreeSelector: string,
  worktreePath: string | null | undefined
): string {
  return JSON.stringify([
    target.environmentId,
    getRuntimeEnvironmentRevision(target.environmentId) ?? 'unknown',
    worktreeSelector,
    worktreePath ?? null
  ])
}

export function clearLegacyQuickOpenInventoryCacheForTests(): void {
  inventoryCache.clear()
}

export function hasCachedLegacyQuickOpenInventory(
  target: EnvironmentTarget,
  worktreeSelector: string,
  worktreePath: string | null | undefined
): boolean {
  const entry = inventoryCache.get(cacheKey(target, worktreeSelector, worktreePath))
  return entry !== undefined && entry.expiresAt > Date.now()
}

async function loadLegacyQuickOpenInventory(
  target: EnvironmentTarget,
  worktreeSelector: string,
  worktreePath: string | null | undefined,
  signal?: AbortSignal
): Promise<RuntimeFileListResult> {
  const key = cacheKey(target, worktreeSelector, worktreePath)
  const now = Date.now()
  const expectedEnvironmentPairingRevision = getRuntimeEnvironmentRevision(target.environmentId)
  const cached = inventoryCache.get(key)
  if (cached && cached.expiresAt > now) {
    inventoryCache.delete(key)
    inventoryCache.set(key, cached)
    return awaitLegacyInventoryLoad(cached, signal)
  }
  inventoryCache.delete(key)

  let entry: CacheEntry
  const controller = new AbortController()
  if (signal?.aborted) {
    controller.abort()
  }
  // Share one inventory request; abort it only after every caller detaches.
  const load = callRuntimeRpc<RuntimeFileListResult>(
    target,
    'files.list',
    { worktree: worktreeSelector },
    {
      timeoutMs: 15_000,
      ...(signal === undefined ? {} : { signal: controller.signal }),
      expectedEnvironmentPairingRevision
    }
  )
    .then((result) => {
      entry.settled = true
      entry.expiresAt = Date.now() + CACHE_TTL_MS
      return result
    })
    .catch((error) => {
      entry.settled = true
      if (inventoryCache.get(key) === entry) {
        inventoryCache.delete(key)
      }
      throw error
    })
  entry = {
    expiresAt: now + CACHE_TTL_MS,
    load,
    controller,
    activeConsumers: 0,
    settled: false
  }
  inventoryCache.set(key, entry)
  while (inventoryCache.size > CACHE_LIMIT) {
    const oldest = inventoryCache.keys().next().value as string | undefined
    if (!oldest) {
      break
    }
    inventoryCache.delete(oldest)
  }
  return awaitLegacyInventoryLoad(entry, signal)
}

async function awaitLegacyInventoryLoad(
  entry: CacheEntry,
  signal?: AbortSignal
): Promise<RuntimeFileListResult> {
  if (signal?.aborted) {
    throw createRuntimeRpcAbortError()
  }
  entry.activeConsumers += 1
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    entry.activeConsumers -= 1
    if (entry.activeConsumers === 0 && !entry.settled) {
      entry.expiresAt = 0
      for (const [key, cached] of inventoryCache) {
        if (cached === entry) {
          inventoryCache.delete(key)
          break
        }
      }
      entry.controller.abort()
    }
  }
  if (!signal) {
    return entry.load.finally(release)
  }
  return new Promise<RuntimeFileListResult>((resolve, reject) => {
    const onAbort = (): void => {
      release()
      reject(createRuntimeRpcAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    entry.load.then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        release()
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        release()
        reject(error)
      }
    )
  })
}

export async function searchLegacyQuickOpenInventory(args: {
  target: EnvironmentTarget
  worktreeSelector: string
  query: string
  limit: number
  worktreePath: string | null | undefined
  excludePaths: string[] | undefined
  signal?: AbortSignal
}): Promise<{ files: string[]; truncated: boolean }> {
  const result = await loadLegacyQuickOpenInventory(
    args.target,
    args.worktreeSelector,
    args.worktreePath,
    args.signal
  )
  const excludePrefixes = buildExcludePathPrefixes(
    args.worktreePath ?? result.rootPath,
    args.excludePaths
  )
  const ranker = new QuickOpenPathRanker(args.query, args.limit)
  for (const entry of result.files) {
    if (!shouldExcludeQuickOpenRelPath(entry.relativePath, excludePrefixes)) {
      ranker.consider(entry.relativePath)
    }
  }
  const matches = ranker.result()
  return {
    files: matches.paths,
    truncated: result.truncated || matches.totalCount > args.limit
  }
}
