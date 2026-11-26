import { lstat } from 'node:fs/promises'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../host-catalog/runtime-environments'
import type {
  EnvironmentStoreCommand,
  EnvironmentStoreSuccess
} from './runtime-environment-store-worker-protocol'
import { resolveEnvironmentFromStore } from './runtime-environment-selection'

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

export type CacheableEnvironmentStoreRead = Extract<
  EnvironmentStoreCommand,
  { operation: 'listEnvironments' | 'resolveEnvironment' | 'resolveEnvironmentPairingOffer' }
>

export function isCacheableEnvironmentStoreRead(
  command: EnvironmentStoreCommand
): command is CacheableEnvironmentStoreRead {
  if (command.operation === 'listEnvironments') {
    return !command.args[1]?.requireStoreFile && !command.args[1]?.recoverBlankStore
  }
  return (
    command.operation === 'resolveEnvironment' ||
    command.operation === 'resolveEnvironmentPairingOffer'
  )
}

function answerFromCachedEnvironments(
  command: CacheableEnvironmentStoreRead,
  environments: KnownRuntimeEnvironment[]
): EnvironmentStoreSuccess {
  if (command.operation === 'listEnvironments') {
    return { operation: 'listEnvironments', value: environments }
  }
  const resolved = resolveEnvironmentFromStore({ environments }, command.args[1])
  if (command.operation === 'resolveEnvironment') {
    return { operation: 'resolveEnvironment', value: resolved }
  }
  return {
    operation: 'resolveEnvironmentPairingOffer',
    value: getPreferredPairingOffer(resolved)
  }
}

export async function runCachedEnvironmentStoreRead(args: {
  command: CacheableEnvironmentStoreRead
  servingWsl: boolean
  observe?: (generation: number) => void
  readWrites: () => number
  isClosing: () => boolean
  isIdle: () => boolean
  enqueue: () => Promise<EnvironmentStoreSuccess>
}): Promise<EnvironmentStoreSuccess> {
  const userDataPath = args.command.args[0]
  const startWrites = args.readWrites()
  const stamp = await readEnvironmentStoreListStamp(userDataPath, args.servingWsl)
  if (args.isClosing()) {
    throw new Error('Environment store is closing')
  }
  if (stamp && args.readWrites() === startWrites && args.isIdle()) {
    const environments = stamp.allMissing ? [] : getCachedEnvironmentList(userDataPath, stamp.token)
    if (environments !== null) {
      const reply = answerFromCachedEnvironments(args.command, environments)
      args.observe?.(startWrites)
      return reply
    }
  }
  const reply = await args.enqueue()
  if (
    reply.operation === 'listEnvironments' &&
    stamp?.settled &&
    args.readWrites() === startWrites
  ) {
    setCachedEnvironmentList(userDataPath, stamp.token, reply.value)
  }
  return reply
}
