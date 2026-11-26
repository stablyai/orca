import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { connectedRuntimeStatus } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import {
  clearRuntimeCompatibilityCache,
  compatibilityEntry,
  observedRuntimeEnvironmentRuntimeId,
  rememberRuntimeEnvironmentCompatibility
} from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import type { AgentSessionSubscribeEvent } from '../../../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  createCommandDetailAuthority,
  type CommandDetailAuthority
} from '../../../../../../../shared/agent-session/view/live-read/command-detail-authority'

const hoisted = vi.hoisted((): { owner: unknown } => ({ owner: null }))
vi.mock('../../../session/structured/read/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: () => hoisted.owner
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpcResponse: vi.fn() }))

import { openWorkerDockCommandDetail } from './worker-dock-command-detail'

// Real status admission, real compatibility cache, real connection generation: only the read
// owner and the transport are doubles.
const ENV = 'env-status-synthetic'
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

function credit(runtimeId: string): void {
  const scope = { transport: {}, generation: 1 }
  authority.invalidate(scope)
  authority.seed(scope, { epoch: 'e', sequence: 2 })
  authority.observe(scope, frame(), runtimeId)
}

function reply(runtimeId: string) {
  return { id: 'r', ok: true as const, result: { command: EXACT }, _meta: { runtimeId } }
}

/** The send check the transport runs just before a request leaves. */
function sendCheck(args: unknown[]): () => void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; the fourth argument is the call's options object
  return (args[3] as { beforeSend: () => void }).beforeSend
}

/** A read the test answers later. */
function heldCall() {
  let answer: (value: unknown) => void = () => {}
  const call = vi.fn((..._args: unknown[]) => new Promise((resolve) => (answer = resolve)))
  return { call, answer: (value: unknown) => answer(value) }
}

function open(call: (...args: unknown[]) => unknown) {
  return openWorkerDockCommandDetail({
    sessionId: SESSION,
    target: PAIRED,
    tuple: TUPLE,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; answers with the RPC envelope fields this path reads
    call: call as never
  })!
}

/** A verified status from `runtimeId`, admitted by the real status setter. */
function admitStatus(runtimeId: string): void {
  useAppStore.getState().setRuntimeEnvironmentStatus(ENV, connectedRuntimeStatus(runtimeId, 0))
}

beforeEach(() => {
  authority = createCommandDetailAuthority()
  hoisted.owner = { commandDetails: authority }
  clearRuntimeCompatibilityCache(ENV)
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  // A proved A probe in the compatibility cache, and no committed renderer status yet.
  const { status } = connectedRuntimeStatus('runtime-a', 0)
  if (status) {
    rememberRuntimeEnvironmentCompatibility(ENV, compatibilityEntry(status))
  }
})

afterEach(() => {
  clearRuntimeCompatibilityCache(ENV)
})

describe('paired command opening against accepted runtime status', () => {
  it('a first verified B status clears the cache, keeps the generation, and still ends an A opening at once', async () => {
    credit('runtime-a')
    const held = heldCall()
    const detail = open(held.call)
    let lost = 0
    detail.opening.onLost(() => (lost += 1))
    const pending = detail.read()
    await vi.waitFor(() => expect(held.call).toHaveBeenCalledTimes(1))
    const generation = getRuntimeEnvironmentConnectionGeneration(ENV)
    // A's stream close is held; only B's status arrives.
    admitStatus('runtime-b')
    // The real path: the cache entry for A is gone and the generation did not move.
    expect(observedRuntimeEnvironmentRuntimeId(ENV)).toBeUndefined()
    expect(getRuntimeEnvironmentConnectionGeneration(ENV)).toBe(generation)
    // Notified on admission, before any click.
    expect(lost).toBe(1)
    // The held A reply is discarded.
    held.answer(reply('runtime-a'))
    await expect(pending).resolves.toBeNull()
    const writes: string[] = []
    await expect(detail.copy(async (text) => void writes.push(text))).resolves.toBe(false)
    expect(writes).toEqual([])
  })

  it('already-read A text cannot be copied after a verified B status', async () => {
    credit('runtime-a')
    const detail = open(vi.fn(async () => reply('runtime-a')))
    await expect(detail.read()).resolves.toBe(EXACT)
    admitStatus('runtime-b')
    expect(detail.opening.valid()).toBe(false)
    // A later A status does not revive it.
    admitStatus('runtime-a')
    const writes: string[] = []
    await expect(detail.copy(async (text) => void writes.push(text))).resolves.toBe(false)
    expect(writes).toEqual([])
  })

  it('an unchanged A status keeps the opening and its Copy', async () => {
    credit('runtime-a')
    admitStatus('runtime-a')
    const detail = open(vi.fn(async () => reply('runtime-a')))
    await expect(detail.read()).resolves.toBe(EXACT)
    admitStatus('runtime-a')
    const writes: string[] = []
    await expect(detail.copy(async (text) => void writes.push(text))).resolves.toBe(true)
    expect(writes).toEqual([EXACT])
  })

  it('an ordinary replacement after a prior A status also ends the A opening', async () => {
    credit('runtime-a')
    admitStatus('runtime-a')
    const detail = open(vi.fn(async () => reply('runtime-a')))
    await expect(detail.read()).resolves.toBe(EXACT)
    admitStatus('runtime-b')
    expect(detail.opening.valid()).toBe(false)
  })

  it('a fresh opening credited by B, with B accepted, works', async () => {
    credit('runtime-a')
    open(vi.fn(async () => reply('runtime-a')))
    admitStatus('runtime-b')
    credit('runtime-b')
    const detail = open(vi.fn(async () => reply('runtime-b')))
    await expect(detail.read()).resolves.toBe(EXACT)
    const writes: string[] = []
    await expect(detail.copy(async (text) => void writes.push(text))).resolves.toBe(true)
    expect(writes).toEqual([EXACT])
  })
})

describe('the opening read deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    credit('runtime-a')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a send held past the deadline (compatibility wait) never leaves, and the preview stays', async () => {
    let releaseCompatibility: () => void = () => {}
    let sends = 0
    const call = vi.fn(async (...args: unknown[]) => {
      await new Promise<void>((resolve) => (releaseCompatibility = resolve))
      sendCheck(args)()
      sends += 1
      return reply('runtime-a')
    })
    const detail = open(call)
    const pending = detail.read()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toBeNull()
    releaseCompatibility()
    await vi.advanceTimersByTimeAsync(0)
    expect(sends).toBe(0)
    // Reading again is the same one read.
    await expect(detail.read()).resolves.toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('a request already sent whose reply lands after the deadline is discarded', async () => {
    let answer: (value: unknown) => void = () => {}
    const call = vi.fn((...args: unknown[]) => {
      sendCheck(args)()
      return new Promise((resolve) => (answer = resolve))
    })
    const detail = open(call)
    const pending = detail.read()
    await vi.advanceTimersByTimeAsync(10_000)
    answer(reply('runtime-a'))
    await expect(pending).resolves.toBeNull()
    const writes: string[] = []
    await expect(detail.copy(async (text) => void writes.push(text))).resolves.toBe(false)
  })

  it('an in-time reply shows, and a fresh opening after an expired one reads again', async () => {
    const expired = open(
      vi.fn(async (...args: unknown[]) => {
        await new Promise((resolve) => setTimeout(resolve, 20_000))
        sendCheck(args)()
        return reply('runtime-a')
      })
    )
    const late = expired.read()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(late).resolves.toBeNull()
    const fresh = open(
      vi.fn(async (...args: unknown[]) => {
        sendCheck(args)()
        return reply('runtime-a')
      })
    )
    await expect(fresh.read()).resolves.toBe(EXACT)
  })
})
