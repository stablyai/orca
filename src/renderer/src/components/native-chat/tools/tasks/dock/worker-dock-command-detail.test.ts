import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  createCommandDetailAuthority,
  type CommandDetailAuthority
} from '../../../../../../../shared/agent-session/view/live-read/command-detail-authority'

const hoisted = vi.hoisted(() => ({
  owner: null as unknown,
  observedRuntime: undefined as string | undefined
}))
vi.mock('../../../session/structured/read/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: () => hoisted.owner
}))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => 4
}))
vi.mock('@/store/slices/runtime-status/runtime-status-connection-generation', () => ({
  getRuntimeEnvironmentConnectionGeneration: () => 1
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-cache', () => ({
  observedRuntimeEnvironmentRuntimeId: () => hoisted.observedRuntime
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpcResponse: vi.fn() }))

import { openWorkerDockCommandDetail } from './worker-dock-command-detail'

const SESSION = 'session-synthetic'
const PAIRED: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-synthetic' }
const TUPLE = { childWorkId: 'child-1', invocationId: 'run-1', generation: 1 }
const EXACT = 'fixture-run --flag "x y"\n  && fixture-done'

function frame(): AgentSessionSubscribeEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  return {
    type: 'batch',
    sessionId: SESSION,
    fence: 3,
    batch: { cursor: { epoch: 'e', sequence: 2 }, items: [], removedItemIds: [], submissions: [] },
    backgroundTasks: {
      state: 'monitoring',
      children: [
        {
          id: TUPLE.childWorkId,
          kind: 'command',
          state: 'working',
          membership: 'live',
          firstObservedAt: 1,
          observedAt: 1,
          stoppable: true,
          invocation: { invocationId: TUPLE.invocationId, generation: TUPLE.generation }
        }
      ],
      commandDetailsAvailable: [TUPLE]
    }
  } as AgentSessionSubscribeEvent
}

let authority: CommandDetailAuthority
let scope: { transport: object; generation: number }

function credit(runtimeId?: string): void {
  scope = { transport: {}, generation: 1 }
  authority.invalidate(scope)
  authority.seed(scope, { epoch: 'e', sequence: 2 })
  authority.observe(scope, frame(), runtimeId)
}

function reply(runtimeId: string, command: unknown = EXACT) {
  return { id: 'r', ok: true as const, result: { command }, _meta: { runtimeId } }
}

beforeEach(() => {
  authority = createCommandDetailAuthority()
  hoisted.owner = { commandDetails: authority }
  hoisted.observedRuntime = undefined
})

describe('paired command detail runtime pinning', () => {
  it('asks only the crediting runtime and shows its unchanged reply', async () => {
    credit('runtime-a')
    const call = vi.fn(async (..._args: unknown[]) => reply('runtime-a'))
    const detail = openWorkerDockCommandDetail({
      sessionId: SESSION,
      target: PAIRED,
      tuple: TUPLE,
      call: call as never
    })!
    await expect(detail.read()).resolves.toBe(EXACT)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]![3]).toMatchObject({
      expectedEnvironmentRuntimeId: 'runtime-a',
      expectedEnvironmentPairingRevision: 4
    })
    const writes: string[] = []
    await expect(detail.copy(async (text) => void writes.push(text))).resolves.toBe(true)
    expect(writes).toEqual([EXACT])
  })

  it('discards a reply that names another runtime, and the opening cannot recover', async () => {
    credit('runtime-a')
    const call = vi.fn(async () => reply('runtime-b'))
    const detail = openWorkerDockCommandDetail({
      sessionId: SESSION,
      target: PAIRED,
      tuple: TUPLE,
      call: call as never
    })!
    let lost = 0
    detail.opening.onLost(() => (lost += 1))
    await expect(detail.read()).resolves.toBeNull()
    expect(lost).toBe(1)
    expect(detail.opening.valid()).toBe(false)
    // Unchanged frames from the crediting runtime still leave this opening lost.
    authority.observe(scope, frame(), 'runtime-a')
    expect(detail.opening.valid()).toBe(false)
    const writes: string[] = []
    await expect(detail.copy(async (text) => void writes.push(text))).resolves.toBe(false)
    expect(writes).toEqual([])
  })

  it('refuses before dispatch once a status names another runtime, even with stream close held', async () => {
    credit('runtime-a')
    const call = vi.fn(async () => reply('runtime-a'))
    const detail = openWorkerDockCommandDetail({
      sessionId: SESSION,
      target: PAIRED,
      tuple: TUPLE,
      call: call as never
    })!
    // The status cache already saw B; A's close and status events have not arrived.
    hoisted.observedRuntime = 'runtime-b'
    await expect(detail.read()).resolves.toBeNull()
    expect(call).not.toHaveBeenCalled()
    hoisted.observedRuntime = 'runtime-a'
    expect(detail.opening.valid()).toBe(false)
  })

  it('a held reply after the status moved to another runtime is discarded', async () => {
    credit('runtime-a')
    let answer: (value: unknown) => void = () => {}
    const call = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    const detail = openWorkerDockCommandDetail({
      sessionId: SESSION,
      target: PAIRED,
      tuple: TUPLE,
      call: call as never
    })!
    const pending = detail.read()
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    hoisted.observedRuntime = 'runtime-b'
    answer(reply('runtime-a'))
    await expect(pending).resolves.toBeNull()
  })

  it('a paired reader with no credited runtime opens nothing and never reads', () => {
    credit(undefined)
    const call = vi.fn()
    expect(
      openWorkerDockCommandDetail({
        sessionId: SESSION,
        target: PAIRED,
        tuple: TUPLE,
        call: call as never
      })
    ).toBeNull()
    expect(call).not.toHaveBeenCalled()
    // Fresh credit from a known runtime recovers.
    credit('runtime-a')
    expect(
      openWorkerDockCommandDetail({ sessionId: SESSION, target: PAIRED, tuple: TUPLE })
    ).not.toBeNull()
  })
})
