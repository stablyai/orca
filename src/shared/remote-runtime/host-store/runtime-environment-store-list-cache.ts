import { lstat } from 'node:fs/promises'
import type { KnownRuntimeEnvironment } from '../host-catalog/runtime-environments'
import type {
  EnvironmentStoreCommand,
  EnvironmentStoreSuccess
} from './runtime-environment-store-worker-protocol'

export const ENVIRONMENT_STORE_READ_OPERATIONS = new Set<EnvironmentStoreCommand['operation']>([
  'listEnvironments',
  'parseRemotePairingCode',
  'resolveEnvironment',
  'resolveEnvironmentPairingOffer',
  'findWslHostDeployment',
  'readEnvironmentStoreRecords',
  'readWslHostDeployments'
])
import { getEnvironmentStorePath } from './runtime-environment-store-records'
import { getRuntimeEnvironmentSidecarPath } from './runtime-environment-sidecar'
import { getWslHostDeploymentStorePath } from './wsl-host-deployment-store'

// Same racy-stamp guard as foreign-sqlite-reader: only cache when all files are settled >3s.
const STAMP_SETTLE_MS = 3_000
const MAX_CACHE_ENTRIES = 16

type FileStamp = { token: string; newestMs: number } | 'missing' | null
export type EnvironmentStoreListStamp = {
  token: string
  settled: boolean
  allMissing: boolean
}

const listCache = new Map<string, { token: string; value: KnownRuntimeEnvironment[] }>()

async function lstatRegularFileStamp(path: string): Promise<FileStamp> {
  try {
    const info = await lstat(path)
    // Non-regular files (symlinks, directories) must go through the worker's security checks.
    if (!info.isFile()) {
      return null
    }
    return {
      token: `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
      newestMs: Math.max(info.mtimeMs, info.ctimeMs)
    }
  } catch (error) {
    // Only ENOENT is 'missing': the worker read fails closed on ENOTDIR (userDataPath is not a
    // directory), so the allMissing fast path must not answer [] for it.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 'missing'
    }
    return null
  }
}

export async function readEnvironmentStoreListStamp(
  userDataPath: string,
  servingWsl: boolean
): Promise<EnvironmentStoreListStamp | null> {
  const settledBeforeMs = Date.now() - STAMP_SETTLE_MS
  const [storeStamp, sidecarStamp, wslStamp] = await Promise.all([
    lstatRegularFileStamp(getEnvironmentStorePath(userDataPath)),
    lstatRegularFileStamp(getRuntimeEnvironmentSidecarPath(userDataPath)),
    lstatRegularFileStamp(getWslHostDeploymentStorePath(userDataPath))
  ])
  if (storeStamp === null || sidecarStamp === null || wslStamp === null) {
    return null
  }
  const stamps = [storeStamp, sidecarStamp, wslStamp]
  const allMissing = stamps.every((entry) => entry === 'missing')
  const tokens = stamps.map((entry) => (entry === 'missing' ? 'missing' : entry.token))
  return {
    token: `${servingWsl ? '1' : '0'}|${tokens.join('|')}`,
    settled: stamps.every((entry) => entry === 'missing' || entry.newestMs < settledBeforeMs),
    allMissing
  }
}

export function getCachedEnvironmentList(
  userDataPath: string,
  token: string
): KnownRuntimeEnvironment[] | null {
  const cached = listCache.get(userDataPath)
  return cached && cached.token === token ? structuredClone(cached.value) : null
}

export function setCachedEnvironmentList(
  userDataPath: string,
  token: string,
  value: KnownRuntimeEnvironment[]
): void {
  if (listCache.size >= MAX_CACHE_ENTRIES && !listCache.has(userDataPath)) {
    const oldest = listCache.keys().next().value
    if (oldest !== undefined) {
      listCache.delete(oldest)
    }
  }
  listCache.set(userDataPath, { token, value: structuredClone(value) })
}

export function clearEnvironmentListCache(): void {
  listCache.clear()
}

export async function runCachedListEnvironments(args: {
  userDataPath: string
  servingWsl: boolean
  observe?: (generation: number) => void
  readWrites: () => number
  isClosing: () => boolean
  isIdle: () => boolean
  enqueue: () => Promise<EnvironmentStoreSuccess>
}): Promise<EnvironmentStoreSuccess> {
  const startWrites = args.readWrites()
  const stamp = await readEnvironmentStoreListStamp(args.userDataPath, args.servingWsl)
  if (args.isClosing()) {
    throw new Error('Environment store is closing')
  }
  if (stamp && args.readWrites() === startWrites && args.isIdle()) {
    if (stamp.allMissing) {
      args.observe?.(startWrites)
      return { operation: 'listEnvironments', value: [] }
    }
    const cached = getCachedEnvironmentList(args.userDataPath, stamp.token)
    if (cached) {
      args.observe?.(startWrites)
      return { operation: 'listEnvironments', value: cached }
    }
  }
  const reply = await args.enqueue()
  if (
    reply.operation === 'listEnvironments' &&
    stamp?.settled &&
    args.readWrites() === startWrites
  ) {
    setCachedEnvironmentList(args.userDataPath, stamp.token, reply.value)
  }
  return reply
}
