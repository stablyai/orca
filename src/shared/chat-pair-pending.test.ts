import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_PAIR_PENDING_CONFIRM_MS,
  ChatPairReplyMissingError,
  createChatPairPendingWrites,
  type ChatPairWriteReply,
  type ChatPairWriteRequest
} from './chat-pair-pending'
import type { RuntimeSessionTabChatViewWrite } from './runtime-session-contracts'
import type { TerminalChatPair } from './terminal-tab-view-mode'

type Sent = {
  request: ChatPairWriteRequest
  write: RuntimeSessionTabChatViewWrite
  resolve: (reply: ChatPairWriteReply) => void
  reject: (error: unknown) => void
}

class DeliveryUnknown extends Error {}

function createRig(onShow?: (pair: TerminalChatPair | null) => void) {
  let hostPair: TerminalChatPair | null = { viewMode: 'terminal' }
  const sent: Sent[] = []
  const shown: (TerminalChatPair | null)[] = []
  const failures: unknown[] = []
  const machine = createChatPairPendingWrites<string>({
    writerId: 'writer-w',
    keyId: (key) => key,
    readHostPair: () => hostPair,
    send: (_key, request, write) =>
      new Promise<ChatPairWriteReply>((resolve, reject) => {
        sent.push({ request, write, resolve, reject })
      }),
    isDeliveryUnknown: (error) => error instanceof DeliveryUnknown,
    showPending: (_key, pair) => {
      shown.push(pair)
      onShow?.(pair)
    },
    reportFailure: (_key, error) => failures.push(error),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handles come from setTimeout above.
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  })
  return {
    machine,
    sent,
    shown,
    failures,
    setHostPair: (pair: TerminalChatPair | null) => {
      hostPair = pair
    }
  }
}

const CHAT_A = { viewMode: 'chat', chatLeafId: 'A' } as const
const TERMINAL = { viewMode: 'terminal' } as const

describe('createChatPairPendingWrites', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends every write at once with increasing sequence numbers', () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.machine.submit('tab', { viewMode: 'terminal', leafId: null }, TERMINAL)
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    expect(rig.sent.map((entry) => entry.write)).toEqual([
      { writerId: 'writer-w', seq: 1 },
      { writerId: 'writer-w', seq: 2 },
      { writerId: 'writer-w', seq: 3 }
    ])
    expect(rig.machine.pendingPair('tab')).toEqual(CHAT_A)
  })

  it('keeps the sequence counter across keys and drops', () => {
    const rig = createRig()
    rig.machine.submit('one', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.machine.drop('one')
    rig.machine.submit('two', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    expect(rig.sent.map((entry) => entry.write.seq)).toEqual([1, 2])
  })

  it('ignores a failure of an older write once a newer one is pending', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.machine.submit('tab', { viewMode: 'terminal', leafId: null }, TERMINAL)
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.sent[0].reject(new Error('refused'))
    await vi.runAllTimersAsync()
    expect(rig.failures).toEqual([])
    expect(rig.sent).toHaveLength(3)
    expect(rig.machine.pendingPair('tab')).toEqual(CHAT_A)
  })

  it('retires at once when the host already shows the adopted reply', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.setHostPair(CHAT_A)
    rig.sent[0].resolve({ chatView: { viewMode: 'chat', chatLeafId: 'A' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.machine.pendingPair('tab')).toBeNull()
    expect(rig.shown.at(-1)).toBeNull()
  })

  it('adopts a normalized reply and retires on the snapshot that shows it', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: null }, { viewMode: 'chat' })
    rig.sent[0].resolve({ chatView: { viewMode: 'chat', chatLeafId: 'B' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.machine.pendingPair('tab')).toEqual({ viewMode: 'chat', chatLeafId: 'B' })
    rig.machine.hostPairChanged('tab')
    expect(rig.machine.pendingPair('tab')).not.toBeNull()
    rig.setHostPair({ viewMode: 'chat', chatLeafId: 'B' })
    rig.machine.hostPairChanged('tab')
    expect(rig.machine.pendingPair('tab')).toBeNull()
  })

  it('retires an ownerless chat reply once the host shows chat on any pane', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: null }, { viewMode: 'chat' })
    rig.sent[0].resolve({ chatView: { viewMode: 'chat', chatLeafId: null } })
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.machine.pendingPair('tab')).toEqual({ viewMode: 'chat' })
    // The host then picks its own pane for the chat.
    rig.setHostPair({ viewMode: 'chat', chatLeafId: 'B' })
    rig.machine.hostPairChanged('tab')
    expect(rig.machine.pendingPair('tab')).toBeNull()
  })

  it('does not count a host chat from before an earlier unconfirmed write as shown', async () => {
    const rig = createRig()
    rig.setHostPair(CHAT_A)
    rig.machine.submit('tab', { viewMode: 'terminal', leafId: null }, TERMINAL)
    rig.machine.submit('tab', { viewMode: 'chat', leafId: null }, { viewMode: 'chat' })
    rig.sent[1].resolve({ chatView: { viewMode: 'chat', chatLeafId: null } })
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.machine.pendingPair('tab')).toEqual({ viewMode: 'chat' })
    // The first write's snapshot arrives late.
    rig.setHostPair(TERMINAL)
    rig.machine.hostPairChanged('tab')
    expect(rig.machine.pendingPair('tab')).toEqual({ viewMode: 'chat' })
    rig.setHostPair({ viewMode: 'chat', chatLeafId: 'B' })
    rig.machine.hostPairChanged('tab')
    expect(rig.machine.pendingPair('tab')).toBeNull()
  })

  it('expires an adopted reply the host never shows', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.sent[0].resolve({ chatView: { viewMode: 'chat', chatLeafId: 'A' } })
    await vi.advanceTimersByTimeAsync(CHAT_PAIR_PENDING_CONFIRM_MS - 1)
    expect(rig.machine.pendingPair('tab')).toEqual(CHAT_A)
    await vi.advanceTimersByTimeAsync(1)
    expect(rig.machine.pendingPair('tab')).toBeNull()
    expect(rig.failures).toEqual([])
  })

  it('does not let an older entry deadline expire a newer write', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.sent[0].resolve({ chatView: { viewMode: 'chat', chatLeafId: 'A' } })
    await vi.advanceTimersByTimeAsync(CHAT_PAIR_PENDING_CONFIRM_MS - 1)
    rig.machine.submit('tab', { viewMode: 'terminal', leafId: null }, TERMINAL)
    await vi.advanceTimersByTimeAsync(CHAT_PAIR_PENDING_CONFIRM_MS * 2)
    expect(rig.machine.pendingPair('tab')).toEqual(TERMINAL)
  })

  it('resends a delivery-unknown write once with the same writer and sequence', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.sent[0].reject(new DeliveryUnknown('timeout'))
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.sent).toHaveLength(2)
    expect(rig.sent[1].write).toEqual(rig.sent[0].write)
    expect(rig.sent[1].request).toEqual(rig.sent[0].request)
    rig.setHostPair(CHAT_A)
    rig.sent[1].resolve({ chatView: { viewMode: 'chat', chatLeafId: 'A' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.machine.pendingPair('tab')).toBeNull()
    expect(rig.failures).toEqual([])
  })

  it('never resends an older sequence after a newer write', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.machine.submit('tab', { viewMode: 'terminal', leafId: null }, TERMINAL)
    rig.sent[0].reject(new DeliveryUnknown('timeout'))
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.sent.map((entry) => entry.write.seq)).toEqual([1, 2])
  })

  it('reports once and returns to the host pair when the resend also fails', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.sent[0].reject(new DeliveryUnknown('timeout'))
    await vi.advanceTimersByTimeAsync(0)
    rig.sent[1].reject(new DeliveryUnknown('timeout again'))
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.failures).toHaveLength(1)
    expect(rig.machine.pendingPair('tab')).toBeNull()
    expect(rig.shown.at(-1)).toBeNull()
  })

  it('reports a definitive failure without resending', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.sent[0].reject(new Error('tab_not_found'))
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.sent).toHaveLength(1)
    expect(rig.failures).toHaveLength(1)
    expect(rig.machine.pendingPair('tab')).toBeNull()
  })

  it('treats a reply without a chat view as a failure', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.sent[0].resolve({})
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.failures).toEqual([expect.any(ChatPairReplyMissingError)])
    expect(rig.machine.pendingPair('tab')).toBeNull()
  })

  it('ends the entry and reports when the reply is not an object', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a host breaking the reply contract.
    rig.sent[0].resolve(null as unknown as ChatPairWriteReply)
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.failures).toEqual([expect.any(TypeError)])
    expect(rig.machine.pendingPair('tab')).toBeNull()
    expect(rig.shown.at(-1)).toBeNull()
  })

  it('ends the entry and reports when showing the adopted reply throws', async () => {
    const rig = createRig((pair) => {
      if (pair?.chatLeafId === 'B') {
        throw new Error('subscriber failed')
      }
    })
    rig.machine.submit('tab', { viewMode: 'chat', leafId: null }, { viewMode: 'chat' })
    rig.sent[0].resolve({ chatView: { viewMode: 'chat', chatLeafId: 'B' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.failures).toEqual([new Error('subscriber failed')])
    expect(rig.machine.pendingKeys()).toEqual([])
    expect(rig.shown.at(-1)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('adopts the current pair from a superseded reply', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.sent[0].resolve({ chatView: { viewMode: 'terminal', chatLeafId: null }, superseded: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.machine.pendingPair('tab')).toBeNull()
    expect(rig.failures).toEqual([])
  })

  it('drops without reporting, and a late reply for the dropped write does nothing', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    rig.machine.drop('tab')
    expect(rig.machine.pendingKeys()).toEqual([])
    rig.sent[0].resolve({ chatView: { viewMode: 'chat', chatLeafId: 'A' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(rig.shown).toEqual([CHAT_A, null])
    expect(rig.failures).toEqual([])
  })
})

describe('pending pair settlement for a waiting send (click-then-send)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is null with nothing pending and resolves with the adopted host reply', async () => {
    const rig = createRig()
    expect(rig.machine.settled('tab')).toBeNull()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    const settled = rig.machine.settled('tab')
    rig.sent[0]!.resolve({ chatView: { viewMode: 'chat', chatLeafId: 'A' } })
    await expect(settled).resolves.toEqual({ kind: 'applied', pair: CHAT_A })
  })

  it('fails a waiting send when a newer switch supersedes it, the write fails, or it is dropped', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    const superseded = rig.machine.settled('tab')
    rig.machine.submit('tab', { viewMode: 'terminal', leafId: null }, TERMINAL)
    await expect(superseded).resolves.toEqual({ kind: 'failed' })
    const failed = rig.machine.settled('tab')
    rig.sent[1]!.reject(new Error('refused'))
    await expect(failed).resolves.toEqual({ kind: 'failed' })
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    const dropped = rig.machine.settled('tab')
    rig.machine.drop('tab')
    await expect(dropped).resolves.toEqual({ kind: 'failed' })
  })

  it('reports a host that normalized the switch to terminal, so the send writes nothing', async () => {
    const rig = createRig()
    rig.machine.submit('tab', { viewMode: 'chat', leafId: 'A' }, CHAT_A)
    const settled = rig.machine.settled('tab')
    rig.sent[0]!.resolve({ chatView: { viewMode: 'terminal', chatLeafId: null } })
    await expect(settled).resolves.toEqual({ kind: 'applied', pair: { viewMode: 'terminal' } })
  })
})
