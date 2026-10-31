import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
} from '../../../../shared/protocol-version'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY as exact } from '../../../../shared/source-control-runtime-capabilities'
import { createGitHubApi } from './web-github-api'
import { callEnvironmentEnvelope } from './web-runtime-calls'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

const network = vi.hoisted(() => ({
  client: { connectionEpoch: 1, runtimeId: 'a', call: vi.fn() },
  environment: { id: 'paired', createdAt: 1, pairingRevision: 1 }
}))
vi.mock('./web-runtime-session', async () => {
  const { RuntimeRpcCallQueuePool } = await import('../../../../shared/runtime-rpc-call-queue')
  return {
    getClientForEnvironment: () => network.client,
    requireActiveEnvironment: () => network.environment,
    resolveEnvironment: () => network.environment,
    updateEnvironmentFromResponse: () => {},
    manuallyDisconnectedEnvironmentIds: new Set<string>(),
    manuallyDisconnectedResponse: () => ({ ok: false }),
    runtimeCallQueuePool: new RuntimeRpcCallQueuePool(1)
  }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ repos: [] }) } }))
const ownerRepo = { owner: 'fork', repo: 'widgets', host: 'github.corp' }
const effects: unknown[] = []
let afterProbe: (() => void) | undefined
let onQueuedWrite: (() => void) | undefined
beforeEach(() => {
  clearRuntimeCompatibilityCache()
  effects.length = 0
  afterProbe = undefined
  onQueuedWrite = undefined
  network.environment.pairingRevision = 1
  network.client.connectionEpoch = 1
  network.client.runtimeId = 'a'
  replaceRuntimeEnvironmentRevisions([network.environment])
  network.client.call.mockReset().mockImplementation(async (method, params) => {
    if (method === 'status.get') {
      const runtimeId = network.client.runtimeId
      const result = {
        runtimeId,
        capabilities: [exact],
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
      }
      afterProbe?.()
      afterProbe = undefined
      return { id: 'status', ok: true, result, _meta: { runtimeId } }
    }
    effects.push(params)
    return {
      id: 'write',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: network.client.runtimeId }
    }
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: (args) => {
          if (args.method === 'github.updateIssue') {
            onQueuedWrite?.()
          }
          return callEnvironmentEnvelope(
            args.selector,
            args.method,
            args.params,
            args.timeoutMs,
            args.expectedEnvironmentPairingRevision,
            args.expectedEnvironmentRuntimeId
          )
        }
      }
    }
  })
})
afterEach(() => vi.unstubAllGlobals())
function update() {
  return createGitHubApi().updateIssue({
    repoPath: '/clone',
    repoId: 'clone',
    number: 93,
    ownerRepo,
    updates: { body: 'fork edit' }
  })
}

it('the real API/preparation/runtime queue refuses a re-pair behind an occupied slot and a fresh supported attempt succeeds', async () => {
  let release!: () => void
  let held!: Promise<unknown>
  let entered!: () => void
  const occupied = new Promise<void>((resolve) => {
    entered = resolve
  })
  afterProbe = () => {
    markRuntimeEnvironmentCompatible('paired')
    // Occupy the actual per-environment queue before the prepared write reaches it.
    network.client.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          entered()
          release = () => resolve({ id: 'held', ok: true, result: {} })
        })
    )
    held = callEnvironmentEnvelope('paired', 'files.read', {})
  }
  let queued!: () => void
  const waitingWrite = new Promise<void>((resolve) => {
    queued = resolve
  })
  onQueuedWrite = queued
  const pending = update()
  // Await the external I/O boundary, without polling the runtime queue implementation.
  await occupied
  await waitingWrite
  expect(release).toBeTypeOf('function')
  const refused = expect(pending).rejects.toThrow()
  network.environment.pairingRevision = 2
  network.client.connectionEpoch = 2
  network.client.runtimeId = 'b'
  replaceRuntimeEnvironmentRevisions([network.environment], { retired: ['paired'], sameHost: [] })
  release()
  await held
  await refused
  expect(effects).toEqual([])
  clearRuntimeCompatibilityCache()
  await expect(update()).resolves.toEqual({ ok: true })
  expect(effects).toEqual([expect.objectContaining({ ownerRepo, number: 93 })])
})
it('retains a definitive mutation response when pairing changes after physical admission, without replay', async () => {
  await update()
  effects.length = 0
  let answer!: (reply: unknown) => void
  network.client.call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  const pending = callEnvironmentEnvelope(
    'paired',
    'github.updateIssue',
    { ownerRepo },
    30_000,
    1,
    'a'
  )
  expect(answer).toBeTypeOf('function')
  network.environment.pairingRevision = 2
  answer({ id: 'ack', ok: true, result: { ok: true }, _meta: { runtimeId: 'a' } })
  await expect(pending).resolves.toMatchObject({ ok: true, result: { ok: true } })
})
