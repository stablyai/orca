import { captureEnvironmentStoreRead } from './runtime-environment-store-read-observation'
import type { Worker } from 'node:worker_threads'
import type { runEnvironmentStoreBatch } from './runtime-environment-store-batch'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../../main/worker-threads/worker-thread-entry-path'
import { spawnWorkerThread } from '../../../main/worker-threads/worker-thread-spawn'
import { isWslHostsServing } from '../../wsl-host-internal-gate'
import { reportSecurePathHardening } from '../../secure-storage/secure-path-hardening-report'
import {
  RuntimeEnvironmentStoreError,
  warnUnreadableEnvironmentState
} from './runtime-environment-store-records'
import { RuntimeEnvironmentSidecarInvalidError } from './runtime-environment-sidecar'
import { WslHostDeploymentStoreInvalidError } from './wsl-host-deployment-store'
import type {
  EnvironmentStoreCommand,
  EnvironmentStoreError,
  EnvironmentStoreMessage,
  EnvironmentStoreResponse,
  EnvironmentStoreSuccess
} from './runtime-environment-store-worker-protocol'

type Pending = {
  command: EnvironmentStoreCommand
  servingWsl: boolean
  observe?: (generation: number) => void
  resolve: (value: EnvironmentStoreSuccess) => void
  reject: (error: Error) => void
}
type Owner = { worker?: Worker; writes: number; active?: { id: number; pending: Pending[] } }
const readers = new Set<EnvironmentStoreCommand['operation']>([
  'listEnvironments',
  'parseRemotePairingCode',
  'resolveEnvironment',
  'resolveEnvironmentPairingOffer',
  'findWslHostDeployment',
  'readEnvironmentStoreRecords',
  'readWslHostDeployments'
])
const queue: Pending[] = []
let owner: Owner | undefined
let sequence = 0
let writes = 0
let retiring: Promise<void> | undefined
let scheduled = false
let closing: Promise<void> | undefined
let finishClose: (() => void) | undefined
let inline = false
let admitted = false
let runInline: typeof runEnvironmentStoreBatch | undefined

/** Only the disposable CLI executable bootstrap may select this before admission. */
export function useInlineEnvironmentStoreForCli(): void {
  if (inline || admitted || closing) {
    throw new Error('Environment store placement is already sealed')
  }
  inline = true
}

/** Parent generation survives worker restarts and invalidates derived pairing caches on uncertainty. */
export function environmentStoreWriteCount(): number {
  return writes
}

function deserializeError(error: EnvironmentStoreError): Error {
  if (error.name === 'RuntimeEnvironmentStoreError') {
    return new RuntimeEnvironmentStoreError(
      error.code === 'invalid_argument' ? 'invalid_argument' : 'runtime_error',
      error.message,
      error.pairingFailure
    )
  }
  const result = new Error(error.message)
  if (error.name === 'RuntimeEnvironmentSidecarInvalidError') {
    Object.setPrototypeOf(result, RuntimeEnvironmentSidecarInvalidError.prototype)
  } else if (error.name === 'WslHostDeploymentStoreInvalidError') {
    Object.setPrototypeOf(result, WslHostDeploymentStoreInvalidError.prototype)
  }
  result.name = error.name
  if (error.code) {
    Object.assign(result, { code: error.code })
  }
  return result
}

function fail(current: Owner, error: Error): void {
  if (owner !== current) {
    return
  }
  owner = undefined
  writes++
  for (const item of [...(current.active?.pending ?? []), ...queue.splice(0)]) {
    item.reject(error)
  }
  current.active = undefined
  // No accepted mutation is replayed: its rename may already have completed.
  retiring = (current.worker?.terminate() ?? Promise.resolve()).then(
    () => {},
    () => {}
  )
  void retiring.then(() => {
    retiring = undefined
    dispatch()
  })
}

function receive(current: Owner, message: EnvironmentStoreMessage): void {
  if (owner !== current) {
    return
  }
  if (message.kind === 'hardening') {
    const entry = message.entry
    reportSecurePathHardening(entry.targetPath, entry.stage, entry.detail)
    return
  }
  if (message.kind === 'warning') {
    warnUnreadableEnvironmentState(message.message)
    return
  }
  const response: EnvironmentStoreResponse = message
  const active = current.active
  if (!active || active.id !== response.id || active.pending.length !== response.results.length) {
    fail(current, new Error('Invalid environment store worker response'))
    return
  }
  writes += response.writes - current.writes
  current.writes = response.writes
  current.active = undefined
  response.results.forEach((result, i) => {
    const item = active.pending[i]!
    if (result.ok) {
      if (readers.has(item.command.operation)) {
        item.observe?.(writes)
      }
      item.resolve(result.result)
    } else {
      item.reject(deserializeError(result.error))
    }
  })
  dispatch()
}

function dispatch(): void {
  scheduled = false
  if (owner?.active || retiring) {
    return
  }
  if (queue.length === 0) {
    owner?.worker?.unref()
    if (finishClose) {
      const current = owner
      owner = undefined
      if (current?.worker) {
        void current.worker.terminate().then(
          () => finishClose?.(),
          () => finishClose?.()
        )
      } else {
        finishClose()
      }
    }
    return
  }
  try {
    if (!owner) {
      const worker = inline
        ? undefined
        : spawnWorkerThread(
            resolveWorkerThreadEntryPath(
              currentWorkerEntryLayout(__dirname),
              'runtime-environment-store-worker-entry.js'
            ),
            { execArgv: [] }
          )
      const current: Owner = { worker, writes: 0 }
      owner = current
      worker?.on('message', (message: EnvironmentStoreMessage) => receive(current, message))
      worker?.once('error', (error) => fail(current, error))
      worker?.once('exit', (code) =>
        fail(current, new Error(`Environment store worker exited (${code})`))
      )
    }
    const current = owner
    const first = queue.shift()!
    const pending = [first]
    // Only queued readers, all admitted before this dispatch, share the subsequent observation.
    if (readers.has(first.command.operation)) {
      while (
        pending.length < 64 &&
        queue[0] &&
        readers.has(queue[0].command.operation) &&
        queue[0].servingWsl === first.servingWsl
      ) {
        pending.push(queue.shift()!)
      }
    }
    current.active = { id: ++sequence, pending }
    current.worker?.ref()
    const request = {
      id: sequence,
      servingWsl: first.servingWsl,
      commands: pending.map((item) => item.command)
    }
    if (current.worker) {
      current.worker.postMessage(request)
    } else {
      const ready = runInline
        ? Promise.resolve(runInline)
        : import('./runtime-environment-store-batch.js').then(
            (module) => (runInline = module.runEnvironmentStoreBatch)
          )
      void ready
        .then((run) => receive(current, structuredClone(run(request))))
        .catch((error) => fail(current, error instanceof Error ? error : new Error(String(error))))
    }
  } catch (error) {
    if (owner) {
      fail(owner, error instanceof Error ? error : new Error(String(error)))
    } else {
      for (const item of queue.splice(0)) {
        item.reject(error instanceof Error ? error : new Error(String(error)))
      }
      finishClose?.()
    }
  }
}

export function submitEnvironmentStoreCommand(
  command: EnvironmentStoreCommand
): Promise<EnvironmentStoreSuccess> {
  if (closing) {
    return Promise.reject(new Error('Environment store is closing'))
  }
  admitted = true
  const result = new Promise<EnvironmentStoreSuccess>((resolve, reject) =>
    queue.push({
      command: inline ? structuredClone(command) : command,
      servingWsl: isWslHostsServing(process.env),
      observe: captureEnvironmentStoreRead(),
      resolve,
      reject
    })
  )
  if (!scheduled && !owner?.active) {
    scheduled = true
    setImmediate(dispatch)
  }
  return result
}

/** Call after RPC and other producers stop, before a normal host exit. */
export function closeEnvironmentStore(): Promise<void> {
  if (!closing) {
    closing = new Promise<void>((resolve) => {
      finishClose = resolve
    })
    dispatch()
  }
  return closing
}
