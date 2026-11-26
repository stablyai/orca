// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  createCommandDetailAuthority,
  type CommandDetailAuthority
} from '../../../../../../../shared/agent-session/view/live-read/command-detail-authority'

// The read deadline at its two checkpoints, through the real renderer RPC wrapper
// (callRuntimeRpcResponse -> beforeSend -> environment bridge). Doubles: the read owner, the
// compatibility probe the wrapper awaits, and the IPC bridge it hands the request to. The
// timeout callback is parked (real timers, never advanced); only the admission clock moves.

const hoisted = vi.hoisted(
  (): { owner: unknown; compatibility: (() => Promise<unknown>) | null } => ({
    owner: null,
    compatibility: null
  })
)
vi.mock('../../../session/structured/read/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: () => hoisted.owner
}))
vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', async (original) => ({
  ...(await original<object>()),
  ensureRuntimeEnvironmentCompatible: () => hoisted.compatibility?.() ?? Promise.resolve(null)
}))

import { openWorkerDockCommandDetail } from './worker-dock-command-detail'

const ENV = 'env-deadline-synthetic'
const SESSION = 'session-synthetic'
const PAIRED: RuntimeClientTarget = { kind: 'environment', environmentId: ENV }
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
let clock = 0
let bridge: ReturnType<typeof vi.fn>

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const matchingReply = () => ({
  id: 'r',
  ok: true,
  result: { command: EXACT },
  _meta: { runtimeId: 'runtime-a' }
})

function open() {
  return openWorkerDockCommandDetail({
    sessionId: SESSION,
    target: PAIRED,
    tuple: TUPLE,
    now: () => clock
  })!
}

beforeEach(() => {
  clock = 0
  authority = createCommandDetailAuthority()
  hoisted.owner = { commandDetails: authority }
  hoisted.compatibility = null
  const scope = { transport: {}, generation: 1 }
  authority.invalidate(scope)
  authority.seed(scope, { epoch: 'e', sequence: 2 })
  authority.observe(scope, frame(), 'runtime-a')
  bridge = vi.fn(async () => matchingReply())
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; the wrapper uses only the environment bridge here
  ;(window as unknown as { api: unknown }).api = { runtimeEnvironments: { call: bridge } }
})

afterEach(() => {
  hoisted.compatibility = null
})

describe('the original read deadline, timer callback parked', () => {
  it('compatibility released at the cutoff: the continuation finishes and nothing reaches the bridge', async () => {
    const compatibility = deferred<unknown>()
    let resumed = false
    hoisted.compatibility = () =>
      compatibility.promise.then((value) => {
        resumed = true
        return value
      })
    const detail = open()
    const pending = detail.read()
    // Only the admission clock reaches the cutoff; the timeout callback has not run.
    clock = 10_000
    compatibility.resolve(null)
    await expect(pending).resolves.toBeNull()
    expect(resumed).toBe(true)
    expect(bridge).not.toHaveBeenCalled()
  })

  it('a timely send whose matching reply arrives after the cutoff: preview, nothing kept, no Copy', async () => {
    const reply = deferred<unknown>()
    bridge.mockImplementation(() => reply.promise)
    const detail = open()
    const pending = detail.read()
    await vi.waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
    clock = 10_001
    reply.resolve(matchingReply())
    await expect(pending).resolves.toBeNull()
    const writes: string[] = []
    await expect(detail.copy(async (text) => void writes.push(text))).resolves.toBe(false)
    expect(writes).toEqual([])
  })

  it('control: an in-time send and reply through the same wrapper shows and copies', async () => {
    const detail = open()
    await expect(detail.read()).resolves.toBe(EXACT)
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(bridge.mock.calls[0]![0]).toMatchObject({
      selector: ENV,
      method: 'agentSession.backgroundCommand',
      expectedEnvironmentRuntimeId: 'runtime-a'
    })
    const writes: string[] = []
    await expect(detail.copy(async (text) => void writes.push(text))).resolves.toBe(true)
    expect(writes).toEqual([EXACT])
  })
})
