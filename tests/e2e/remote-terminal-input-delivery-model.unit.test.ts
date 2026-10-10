import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createModelLink,
  MODEL_TERMINAL_HANDLE,
  type ModelLinkMode
} from './remote-terminal-input-model-link'
import { resetRemoteRuntimeTerminalMultiplexersForTests } from '../../src/renderer/src/runtime/remote-runtime-terminal-multiplexer'
import { createRemoteRuntimePtyTransport } from '../../src/renderer/src/components/terminal-pane/remote-runtime-pty-transport'
import { iterateTerminalInputChunks } from '../../src/shared/terminal-input'

/*
 * Model-based check of remote terminal input delivery: the real pane transport, multiplexer and
 * input journal talk to the real host dispatcher and input ledger over a link that loses, buffers
 * and late-delivers frames, while the host PTY refuses writes or loses their settlement and the
 * host runtime restarts. Invariant: the PTY receives every input the pane did not give up on,
 * each byte once and in order; a withdrawn paste contributes nothing unless its bytes had already
 * reached the host, and nothing typed before it is lost. Once the link is healthy, everything
 * settles with no further resends.
 */

const SCHEDULES_PER_BLOCK = 250
const BLOCKS = 8
const STEPS_PER_SCHEDULE = 60
const BASE_SEED = 0x5eed_2663

type Op = {
  id: number
  text: string
  // Required ops must arrive whole; optional ones may arrive whole, as a chunk prefix, or not at all.
  status: 'required' | 'optional' | 'forbidden'
  accepted: Promise<boolean> | null
  result: boolean | 'pending'
  controller: AbortController | null
}

type WriteFault = 'accept' | 'refuse' | 'unhanded' | 'unknown-written' | 'unknown-lost' | 'throw'

type Stats = {
  schedules: number
  steps: number
  ops: number
  cancelled: number
  cancelledForbidden: number
  restarts: number
  disconnects: number
  zombieFlushes: number
  gaveUp: number
  faults: Record<WriteFault, number>
  ptyBytes: number
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MARKER = /\{(\d+)\}/g

function markersIn(text: string): number[] {
  return Array.from(text.matchAll(MARKER), (match) => Number(match[1]))
}

function track(op: Op, accepted: Promise<boolean> | undefined): void {
  op.accepted = accepted ?? null
  void accepted?.then((value) => {
    op.result = value
  })
}

type ModelLink = ReturnType<typeof createModelLink>

function attachModelPane(
  link: ModelLink,
  environmentId: string,
  callbacks: Parameters<
    ReturnType<typeof createRemoteRuntimePtyTransport>['attach']
  >[0]['callbacks']
): ReturnType<typeof createRemoteRuntimePtyTransport> {
  const call = vi.fn(async (request: { method: string }) =>
    request.method === 'terminal.resolvePane'
      ? {
          ok: true,
          result: {
            terminal: {
              handle: MODEL_TERMINAL_HANDLE,
              tabId: 'tab-1',
              leafId: 'pane:1',
              worktreeId: 'wt-1'
            }
          }
        }
      : { ok: true, result: { terminal: { handle: MODEL_TERMINAL_HANDLE } } }
  )
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { call, subscribe: link.subscribe } },
    location: { search: '' }
  })
  const transport = createRemoteRuntimePtyTransport(environmentId, {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  transport.attach({
    existingPtyId: `remote:${MODEL_TERMINAL_HANDLE}`,
    cols: 80,
    rows: 24,
    callbacks
  })
  return transport
}

async function runSchedule(seed: number, stats: Stats): Promise<void> {
  const random = mulberry32(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  const chance = (p: number): boolean => random() < p
  const ops: Op[] = []
  const ptyWrites: string[] = []
  const reachedHost = new Set<number>()
  const sentByClient = new Set<number>()
  const faultWeights: [WriteFault, number][] = [
    ['accept', 1],
    ['refuse', random() * 0.3],
    ['unhanded', random() * 0.15],
    ['unknown-written', random() * 0.05],
    ['unknown-lost', random() * 0.05],
    ['throw', random() * 0.03]
  ]
  let faultsEnabled = true

  const opById = (id: number): Op | undefined => ops[id]
  // Why only whole-op writes may be lost: a lost middle chunk would leave a hole no oracle can name.
  const isWholeOps = (text: string): boolean => {
    const ids = markersIn(text)
    return ids.length > 0 && ids.map((id) => opById(id)?.text ?? '').join('') === text
  }
  const chooseFault = (text: string): WriteFault => {
    if (!faultsEnabled) {
      return 'accept'
    }
    const total = faultWeights.reduce((sum, [, weight]) => sum + weight, 0)
    let roll = random() * total
    for (const [fault, weight] of faultWeights) {
      roll -= weight
      if (roll < 0) {
        return fault === 'unknown-lost' && !isWholeOps(text) ? 'unknown-written' : fault
      }
    }
    return 'accept'
  }

  const link = createModelLink(async (text) => {
    const fault = chooseFault(text)
    stats.faults[fault] += 1
    if (fault === 'refuse') {
      return {
        accepted: false,
        writeSettlement: {
          outcome: 'refused',
          reason: 'endpoint_awaiting_recovery'
        }
      }
    }
    if (fault === 'unhanded') {
      return {
        accepted: false,
        writeSettlement: {
          outcome: 'unverifiable',
          reason: 'transport_settlement_lost',
          bytesHandedToTransport: false
        }
      }
    }
    if (fault === 'unknown-lost' || (fault === 'throw' && isWholeOps(text))) {
      // The provider handed the bytes off and lost them: never resent, so the pane may miss them.
      for (const id of markersIn(text)) {
        const op = opById(id)
        if (op && op.status === 'required') {
          op.status = 'optional'
        }
      }
    } else {
      ptyWrites.push(text)
    }
    if (fault === 'throw') {
      throw new Error('ssh channel write failed')
    }
    return fault === 'accept'
      ? { accepted: true, writeSettlement: { outcome: 'accepted' } }
      : {
          accepted: false,
          writeSettlement: {
            outcome: 'unverifiable',
            reason: 'transport_settlement_lost',
            bytesHandedToTransport: true
          }
        }
  })
  link.random = random
  link.onClientInput = (text) => markersIn(text).forEach((id) => sentByClient.add(id))
  link.onHostInput = (text) => markersIn(text).forEach((id) => reachedHost.add(id))

  let disconnected = false
  const transport = attachModelPane(link, `env-model-${seed}`, {
    onRecoveryStateChange: (state) => {
      disconnected = state.phase === 'disconnected'
      if (disconnected) {
        stats.gaveUp += 1
        // Why: once auto-recovery gives up, unapplied input is dropped; only bytes a lingering
        // connection already carries may still arrive.
        const applied = ptyWrites.join('')
        for (const op of ops) {
          if (op.status === 'required' && !applied.includes(op.text)) {
            op.status = 'optional'
          }
        }
      }
    }
  })
  await vi.advanceTimersByTimeAsync(50)
  expect(transport.isConnected()).toBe(true)

  const newOp = (body: string): Op => {
    const op: Op = {
      id: ops.length,
      text: `{${ops.length}}${body}`,
      // Why forbidden: input typed into a pane that gave up must never run at a later reconnect.
      status: disconnected ? 'forbidden' : 'required',
      accepted: null,
      result: 'pending',
      controller: null
    }
    ops.push(op)
    stats.ops += 1
    return op
  }
  const withdraw = (op: Op): void => {
    op.controller?.abort()
    stats.cancelled += 1
    // Why: bytes already at the host, or buffered on a link that may still deliver them, cannot be recalled.
    const reachable =
      reachedHost.has(op.id) ||
      link.heldInputTexts().some((text) => markersIn(text).includes(op.id))
    op.status = reachable ? 'optional' : 'forbidden'
    if (!reachable) {
      stats.cancelledForbidden += 1
    }
  }

  const actions: [number, () => void][] = [
    [
      8,
      () => transport.sendInput(newOp(pick(['ls', 'cd', 'echo x\r', 'a', '\x7f'])).text, 'driving')
    ],
    [
      2,
      () => {
        const op = newOp('\x03')
        track(op, transport.sendInputAccepted?.(op.text, 'driving'))
      }
    ],
    [
      3,
      () => {
        const size = chance(0.15)
          ? 16 * 1024 + Math.floor(random() * 24 * 1024)
          : 1 + Math.floor(random() * 3000)
        const op = newOp(`${'p'.repeat(size)};`)
        op.controller = new AbortController()
        track(
          op,
          transport.sendInputAccepted?.(op.text, 'driving', {
            signal: op.controller.signal
          })
        )
      }
    ],
    [
      1,
      () => {
        const pending = ops.filter((op) => op.controller && op.result === 'pending')
        if (pending.length > 0) {
          withdraw(pick(pending))
        }
      }
    ],
    [
      2,
      () => {
        const mode: ModelLinkMode = pick(['hold', 'drop'])
        link.toHost = chance(0.8) ? mode : link.toHost
        link.toClient = chance(0.8) ? mode : link.toClient
      }
    ],
    [1, () => link.heal()],
    [1, () => (link.ackLoss = chance(0.5) ? random() * 0.5 : 0)],
    [
      2,
      () => {
        stats.disconnects += 1
        link.disconnect()
      }
    ],
    [
      1,
      () => {
        stats.zombieFlushes += link.zombieCount > 0 ? 1 : 0
        link.flushZombie()
      }
    ],
    [1, () => link.retireZombies()],
    [1, () => (link.unreachable = chance(0.5))],
    [
      0.3,
      () => {
        stats.restarts += 1
        const applied = ptyWrites.join('')
        for (const op of ops) {
          // Why: a restarted runtime cannot dedupe, so unacked input the pane already sent is dropped.
          if (op.status === 'required' && sentByClient.has(op.id) && !applied.includes(op.text)) {
            op.status = 'optional'
          }
        }
        link.restartHost()
      }
    ]
  ]
  const totalWeight = actions.reduce((sum, [weight]) => sum + weight, 0)
  for (let step = 0; step < STEPS_PER_SCHEDULE; step += 1) {
    let roll = random() * totalWeight
    for (const [weight, action] of actions) {
      roll -= weight
      if (roll < 0) {
        action()
        break
      }
    }
    stats.steps += 1
    await vi.advanceTimersByTimeAsync(chance(0.1) ? 2000 + random() * 20_000 : random() * 400)
  }

  // Heal: the network and the host are healthy again.
  faultsEnabled = false
  link.unreachable = false
  link.ackLoss = 0
  link.heal()
  if (chance(0.5)) {
    link.flushZombie()
  }
  link.retireZombies()
  for (let round = 0; round < 12 && !transport.isConnected(); round += 1) {
    transport.retryRecovery?.()
    await vi.advanceTimersByTimeAsync(10_000)
  }
  await vi.advanceTimersByTimeAsync(60_000)
  expect(transport.isConnected()).toBe(true)

  // No permanent stall: every accepted write settled, and nothing is still being resent.
  const unsettled = ops.filter((op) => op.accepted && op.result === 'pending').map((op) => op.id)
  expect(unsettled, `seed ${seed} accepted writes never settled`).toEqual([])
  const sentBefore = sentByClient.size
  const writesBefore = ptyWrites.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sentByClient.size).toBe(sentBefore)
  expect(ptyWrites.length).toBe(writesBefore)

  const arrived = checkPty(ptyWrites.join(''), ops, seed)
  for (const op of ops) {
    // A write the pane reported applied really reached the PTY, whole.
    if (op.result === true) {
      expect(arrived.has(op.id), `seed ${seed} op ${op.id} reported applied`).toBe(true)
    }
  }
  stats.ptyBytes += ptyWrites.join('').length
  stats.schedules += 1
  transport.destroy?.()
  link.dispose()
  vi.unstubAllGlobals()
  resetRemoteRuntimeTerminalMultiplexersForTests()
}

/** Walks the PTY bytes against the ops in the order they were typed. */
function checkPty(pty: string, ops: readonly Op[], seed: number): Set<number> {
  const arrived = new Set<number>()
  let position = 0
  for (const op of ops) {
    const where = `seed ${seed} op ${op.id} (${op.status}) at ${position}: ${JSON.stringify(pty.slice(position, position + 40))}`
    if (pty.startsWith(op.text, position)) {
      expect(op.status, where).not.toBe('forbidden')
      arrived.add(op.id)
      position += op.text.length
      continue
    }
    if (op.status === 'required') {
      throw new Error(`missing or out of order: ${where}`)
    }
    if (op.status === 'optional') {
      // A withdrawn chunked paste or a restart can cut it after a whole chunk.
      let prefix = ''
      for (const chunk of iterateTerminalInputChunks(op.text)) {
        if (!pty.startsWith(prefix + chunk, position)) {
          break
        }
        prefix += chunk
      }
      position += prefix.length
    }
  }
  if (position !== pty.length) {
    throw new Error(
      `unexpected PTY bytes: seed ${seed} at ${position}: ${JSON.stringify(pty.slice(position, position + 60))}`
    )
  }
  return arrived
}

describe('remote terminal input delivery model', () => {
  const stats: Stats = {
    schedules: 0,
    steps: 0,
    ops: 0,
    cancelled: 0,
    cancelledForbidden: 0,
    restarts: 0,
    disconnects: 0,
    zombieFlushes: 0,
    gaveUp: 0,
    faults: {
      accept: 0,
      refuse: 0,
      unhanded: 0,
      'unknown-written': 0,
      'unknown-lost': 0,
      throw: 0
    },
    ptyBytes: 0
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    resetRemoteRuntimeTerminalMultiplexersForTests()
  })

  for (let block = 0; block < BLOCKS; block += 1) {
    it(`delivers every kept input exactly once, in order, across random faults (block ${block})`, async () => {
      for (let index = 0; index < SCHEDULES_PER_BLOCK; index += 1) {
        await runSchedule(BASE_SEED + block * SCHEDULES_PER_BLOCK + index, stats)
      }
    }, 120_000)
  }

  it('falls back to a remount when the host keeps refusing input after every fault has cleared', async () => {
    const ptyWrites: string[] = []
    let refusing = false
    const link = createModelLink(async (text) => {
      if (refusing) {
        // A stale handle or an unwritable PTY behind a stream that stays open.
        return {
          accepted: false,
          writeSettlement: { outcome: 'refused', reason: 'terminal_not_writable' }
        }
      }
      ptyWrites.push(text)
      return { accepted: true, writeSettlement: { outcome: 'accepted' } }
    })
    const onWriteUnavailable = vi.fn()
    const transport = attachModelPane(link, 'env-model-refusing', { onWriteUnavailable })
    await vi.advanceTimersByTimeAsync(50)
    transport.sendInput('ls\r', 'driving')
    await vi.advanceTimersByTimeAsync(50)
    expect(ptyWrites).toEqual(['ls\r'])
    refusing = true
    transport.sendInput('pwd\r', 'driving')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onWriteUnavailable).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(onWriteUnavailable).toHaveBeenCalledTimes(1)
    expect(ptyWrites).toEqual(['ls\r'])
    transport.destroy?.()
    link.dispose()
  })

  it('exercised every fault the model schedules', () => {
    process.stdout.write(`remote input model: ${JSON.stringify(stats)}\n`)
    expect(stats.schedules).toBe(SCHEDULES_PER_BLOCK * BLOCKS)
    expect(stats.cancelledForbidden).toBeGreaterThan(0)
    expect(stats.restarts).toBeGreaterThan(0)
    expect(stats.zombieFlushes).toBeGreaterThan(0)
    expect(stats.gaveUp).toBeGreaterThan(0)
    for (const count of Object.values(stats.faults)) {
      expect(count).toBeGreaterThan(0)
    }
  })
})
