import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../host-catalog/runtime-environments'
import type {
  EnvironmentStoreCommand,
  EnvironmentStoreSuccess
} from './runtime-environment-store-worker-protocol'
import { resolveEnvironmentFromStore } from './runtime-environment-selection'
import {
  getEnvironmentStorePath,
  RuntimeEnvironmentStoreError,
  type EnvironmentStoreRecords
} from './runtime-environment-store-records'
import { getWslHostDeploymentStorePath, type WslHostDeployments } from './wsl-host-deployment-store'
import {
  ENVIRONMENT_STORE_STAMP_SETTLE_MS,
  lstatRegularFileStamp,
  readEnvironmentStoreListStamp
} from './runtime-environment-store-file-stamps'

export const ENVIRONMENT_STORE_READ_OPERATIONS = new Set<EnvironmentStoreCommand['operation']>([
  'listEnvironments',
  'parseRemotePairingCode',
  'resolveEnvironment',
  'resolveEnvironmentPairingOffer',
  'findWslHostDeployment',
  'readEnvironmentStoreRecords',
  'readWslHostDeployments'
])

const MAX_CACHE_ENTRIES = 16

const listCache = new Map<string, { token: string; value: KnownRuntimeEnvironment[] }>()
const resolvedCache = new Map<string, { token: string; value: KnownRuntimeEnvironment }>()
const wslDeploymentsCache = new Map<string, { token: string; value: WslHostDeployments }>()
const storeRecordsCache = new Map<string, { token: string; value: EnvironmentStoreRecords }>()

function putBounded<T>(
  cache: Map<string, { token: string; value: T }>,
  key: string,
  token: string,
  value: T,
  maxEntries = MAX_CACHE_ENTRIES
): void {
  if (cache.size >= maxEntries && !cache.has(key)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) {
      cache.delete(oldest)
    }
  }
  cache.set(key, { token, value: structuredClone(value) })
}

export function clearEnvironmentListCache(): void {
  listCache.clear()
  resolvedCache.clear()
  wslDeploymentsCache.clear()
  storeRecordsCache.clear()
}

export type CacheableEnvironmentStoreRead = Extract<
  EnvironmentStoreCommand,
  {
    operation:
      | 'listEnvironments'
      | 'resolveEnvironment'
      | 'resolveEnvironmentPairingOffer'
      | 'readWslHostDeployments'
      | 'findWslHostDeployment'
      | 'readEnvironmentStoreRecords'
  }
>

export function isCacheableEnvironmentStoreRead(
  command: EnvironmentStoreCommand
): command is CacheableEnvironmentStoreRead {
  if (
    command.operation === 'listEnvironments' ||
    command.operation === 'readEnvironmentStoreRecords'
  ) {
    return !command.args[1]?.recoverBlankStore
  }
  return (
    command.operation === 'resolveEnvironment' ||
    command.operation === 'resolveEnvironmentPairingOffer' ||
    command.operation === 'readWslHostDeployments' ||
    command.operation === 'findWslHostDeployment'
  )
}

function answerFromCachedEnvironments(
  command: Extract<
    CacheableEnvironmentStoreRead,
    { operation: 'listEnvironments' | 'resolveEnvironment' | 'resolveEnvironmentPairingOffer' }
  >,
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

async function runCachedWslDeploymentsRead(args: {
  command: Extract<
    CacheableEnvironmentStoreRead,
    { operation: 'readWslHostDeployments' | 'findWslHostDeployment' }
  >
  observe?: (generation: number) => void
  readWrites: () => number
  isClosing: () => boolean
  isIdle: () => boolean
  enqueue: () => Promise<EnvironmentStoreSuccess>
}): Promise<EnvironmentStoreSuccess> {
  const userDataPath = args.command.args[0]
  const startWrites = args.readWrites()
  const settledBeforeMs = Date.now() - ENVIRONMENT_STORE_STAMP_SETTLE_MS
  const stamp = await lstatRegularFileStamp(getWslHostDeploymentStorePath(userDataPath))
  if (args.isClosing()) {
    throw new Error('Environment store is closing')
  }
  if (stamp !== null && args.readWrites() === startWrites && args.isIdle()) {
    const cached =
      stamp === 'missing'
        ? { deployments: [], unreadableEnvironmentIds: new Set<string>() }
        : (() => {
            const entry = wslDeploymentsCache.get(userDataPath)
            return entry && entry.token === stamp.token ? structuredClone(entry.value) : null
          })()
    if (cached !== null) {
      args.observe?.(startWrites)
      if (args.command.operation === 'readWslHostDeployments') {
        return { operation: 'readWslHostDeployments', value: cached }
      }
      const selector = args.command.args[1]
      return {
        operation: 'findWslHostDeployment',
        value: cached.deployments.find((record) => record.environmentId === selector) ?? null
      }
    }
  }
  const reply = await args.enqueue()
  if (
    reply.operation === 'readWslHostDeployments' &&
    stamp !== null &&
    stamp !== 'missing' &&
    stamp.newestMs < settledBeforeMs &&
    args.readWrites() === startWrites
  ) {
    putBounded(wslDeploymentsCache, userDataPath, stamp.token, reply.value)
  }
  return reply
}

async function runCachedStoreRecordsRead(args: {
  command: Extract<CacheableEnvironmentStoreRead, { operation: 'readEnvironmentStoreRecords' }>
  observe?: (generation: number) => void
  readWrites: () => number
  isClosing: () => boolean
  isIdle: () => boolean
  enqueue: () => Promise<EnvironmentStoreSuccess>
}): Promise<EnvironmentStoreSuccess> {
  const [userDataPath, options] = args.command.args
  const storePath = getEnvironmentStorePath(userDataPath)
  const startWrites = args.readWrites()
  const settledBeforeMs = Date.now() - ENVIRONMENT_STORE_STAMP_SETTLE_MS
  const stamp = await lstatRegularFileStamp(storePath)
  if (args.isClosing()) {
    throw new Error('Environment store is closing')
  }
  if (stamp !== null && args.readWrites() === startWrites && args.isIdle()) {
    if (stamp === 'missing') {
      if (options?.requireStoreFile) {
        throw new RuntimeEnvironmentStoreError(
          'runtime_error',
          `Could not read Orca environments at ${storePath}; the file is invalid.`
        )
      }
      args.observe?.(startWrites)
      return {
        operation: 'readEnvironmentStoreRecords',
        value: { environments: [], unreadable: [] }
      }
    }
    const entry = storeRecordsCache.get(userDataPath)
    if (entry && entry.token === stamp.token) {
      args.observe?.(startWrites)
      return { operation: 'readEnvironmentStoreRecords', value: structuredClone(entry.value) }
    }
  }
  const reply = await args.enqueue()
  if (
    reply.operation === 'readEnvironmentStoreRecords' &&
    stamp !== null &&
    stamp !== 'missing' &&
    stamp.newestMs < settledBeforeMs &&
    args.readWrites() === startWrites
  ) {
    putBounded(storeRecordsCache, userDataPath, stamp.token, reply.value)
  }
  return reply
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
  if (args.command.operation === 'readEnvironmentStoreRecords') {
    return runCachedStoreRecordsRead({ ...args, command: args.command })
  }
  if (
    args.command.operation === 'readWslHostDeployments' ||
    args.command.operation === 'findWslHostDeployment'
  ) {
    return runCachedWslDeploymentsRead({ ...args, command: args.command })
  }
  const userDataPath = args.command.args[0]
  const startWrites = args.readWrites()
  const stamp = await readEnvironmentStoreListStamp(userDataPath, args.servingWsl)
  if (args.isClosing()) {
    throw new Error('Environment store is closing')
  }
  if (stamp && args.readWrites() === startWrites && args.isIdle()) {
    if (
      args.command.operation === 'listEnvironments' &&
      args.command.args[1]?.requireStoreFile &&
      stamp.storeMissing
    ) {
      throw new RuntimeEnvironmentStoreError(
        'runtime_error',
        `Could not read Orca environments at ${getEnvironmentStorePath(userDataPath)}; the file is invalid.`
      )
    }
    const listEntry = listCache.get(userDataPath)
    const environments = stamp.allMissing
      ? []
      : listEntry && listEntry.token === stamp.token
        ? structuredClone(listEntry.value)
        : null
    if (environments !== null) {
      const reply = answerFromCachedEnvironments(args.command, environments)
      args.observe?.(startWrites)
      return reply
    }
    if (
      args.command.operation === 'resolveEnvironment' ||
      args.command.operation === 'resolveEnvironmentPairingOffer'
    ) {
      const resolvedEntry = resolvedCache.get(`${userDataPath}\0${args.command.args[1]}`)
      if (resolvedEntry && resolvedEntry.token === stamp.token) {
        const resolved = structuredClone(resolvedEntry.value)
        const reply: EnvironmentStoreSuccess =
          args.command.operation === 'resolveEnvironment'
            ? { operation: 'resolveEnvironment', value: resolved }
            : {
                operation: 'resolveEnvironmentPairingOffer',
                value: getPreferredPairingOffer(resolved)
              }
        args.observe?.(startWrites)
        return reply
      }
    }
  }
  const reply = await args.enqueue()
  if (stamp?.settled && args.readWrites() === startWrites) {
    if (reply.operation === 'listEnvironments') {
      putBounded(listCache, userDataPath, stamp.token, reply.value)
    } else if (
      reply.operation === 'resolveEnvironment' &&
      args.command.operation === 'resolveEnvironment'
    ) {
      putBounded(
        resolvedCache,
        `${userDataPath}\0${args.command.args[1]}`,
        stamp.token,
        reply.value,
        64
      )
    }
  }
  return reply
}
