// STA-2854: test host-local parking policy separately from authoritative stream/input/reconnect.
// A windowless runtime proves already-attached PTY streams do not depend on the renderer; the final case covers initially unattached PTYs.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import type { RpcRequest } from '../../src/main/runtime/rpc/core'
import { TERMINAL_METHODS } from '../../src/main/runtime/rpc/methods/terminal'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../src/shared/terminal-stream-protocol'
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  TERMINAL_TAB_HOT_RETAIN_LIMIT,
  canParkTerminalTabRenderer,
  selectColdParkedTerminalTabs
} from '../../src/renderer/src/components/terminal-pane/terminal-hidden-view-parking'
import { buildTerminalTabColdParkCandidates } from '../../src/renderer/src/components/terminal-pane/terminal-tab-park-candidates'
import { createTerminalTabActivationOrder } from '../../src/renderer/src/components/terminal-pane/terminal-tab-activation-order'
import type { TerminalTab } from '../../src/shared/terminal-tab-types'

const WORKTREE_ID = 'repo-1::/tmp/wt'
// Use host-owned snapshot-backed daemon PTYs, matching the remotely viewed local pane.
const ptyIdFor = (n: number): string => `${WORKTREE_ID}@@aaaaaaa${n}`
const SUBSCRIBED_TAB_ID = 'tab-remote-viewed'
const MARKER_BEFORE_PARK = 'STA2854-BEFORE-PARK'
const MARKER_AFTER_PARK = 'STA2854-AFTER-PARK'
const MARKER_AFTER_RECONNECT = 'STA2854-AFTER-RECONNECT'
const CLIENT_INPUT = 'echo STA2854-INPUT\r'

function tabModel(id: string, ptyId: string): TerminalTab {
  return { id, ptyId, generation: 1 } as unknown as TerminalTab
}

// Exceed hot retention with hidden host tabs, including the remotely subscribed target.
function hiddenHostTabs(): TerminalTab[] {
  const tabs: TerminalTab[] = [tabModel(SUBSCRIBED_TAB_ID, ptyIdFor(0))]
  for (let i = 1; i <= TERMINAL_TAB_HOT_RETAIN_LIMIT + 1; i += 1) {
    tabs.push(tabModel(`tab-${i}`, ptyIdFor(i)))
  }
  return tabs
}

describe('STA-2854 A: host cold-park policy vs an active remote subscriber', () => {
  it('parks a locally hidden host pane that a remote client is actively viewing', () => {
    const tabs = hiddenHostTabs()
    const hiddenSinceByTabId = new Map<string, number>()
    const activationOrder = createTerminalTabActivationOrder()
    const t0 = 1_000_000

    buildTerminalTabColdParkCandidates({
      terminalTabs: tabs,
      assignments: new Map(),
      isWorktreeActive: false,
      activeTerminalTabId: null,
      portalTabIds: new Set(),
      shouldMeasureHiddenWorktree: false,
      hiddenSinceByTabId,
      activationOrder,
      nowMs: t0
    })
    expect(hiddenSinceByTabId.get(SUBSCRIBED_TAB_ID)).toBe(t0)

    // Pass 2: exactly the cold-park hysteresis later. The remote client has
    // been driving this tab the whole time; the policy has no input for that.
    const nowMs = t0 + TERMINAL_TAB_COLD_PARK_DELAY_MS
    const candidates = buildTerminalTabColdParkCandidates({
      terminalTabs: tabs,
      assignments: new Map(),
      isWorktreeActive: false,
      activeTerminalTabId: null,
      portalTabIds: new Set(),
      shouldMeasureHiddenWorktree: false,
      hiddenSinceByTabId,
      activationOrder,
      nowMs
    })
    const subscribedCandidate = candidates.find((c) => c.id === SUBSCRIBED_TAB_ID)!

    expect(
      canParkTerminalTabRenderer({
        worktreeId: WORKTREE_ID,
        terminalTab: subscribedCandidate,
        pendingStartupByTabId: {},
        parkingEnabled: true,
        nowMs
      })
    ).toBe(true)

    const parked = selectColdParkedTerminalTabs({
      worktreeId: WORKTREE_ID,
      terminalTabs: candidates,
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs
    })
    expect(parked.has(SUBSCRIBED_TAB_ID)).toBe(true)

    // Negative control: local visibility is the only thing that saves it.
    const visibleCandidate = { ...subscribedCandidate, isVisible: true, hiddenSinceMs: null }
    expect(
      canParkTerminalTabRenderer({
        worktreeId: WORKTREE_ID,
        terminalTab: visibleCandidate,
        pendingStartupByTabId: {},
        parkingEnabled: true,
        nowMs
      })
    ).toBe(false)
  })

  it('does not reset the hidden clock when a remote subscribe background-mounts the tab', () => {
    const tabs = hiddenHostTabs()
    const hiddenSinceByTabId = new Map<string, number>()
    const activationOrder = createTerminalTabActivationOrder()
    const t0 = 1_000_000

    buildTerminalTabColdParkCandidates({
      terminalTabs: tabs,
      assignments: new Map(),
      isWorktreeActive: false,
      activeTerminalTabId: null,
      portalTabIds: new Set(),
      shouldMeasureHiddenWorktree: false,
      hiddenSinceByTabId,
      activationOrder,
      nowMs: t0
    })

    // A background reconnect keeps the stale hidden timestamp, so its first pass is already eligible to park.
    const remountNowMs = t0 + 4 * 60 * 60_000
    const candidates = buildTerminalTabColdParkCandidates({
      terminalTabs: tabs,
      assignments: new Map(),
      isWorktreeActive: false,
      activeTerminalTabId: null,
      portalTabIds: new Set(),
      shouldMeasureHiddenWorktree: false,
      hiddenSinceByTabId,
      activationOrder,
      nowMs: remountNowMs
    })
    const subscribedCandidate = candidates.find((c) => c.id === SUBSCRIBED_TAB_ID)!
    expect(subscribedCandidate.hiddenSinceMs).toBe(t0)
    expect(remountNowMs - subscribedCandidate.hiddenSinceMs!).toBeGreaterThan(
      TERMINAL_TAB_COLD_PARK_DELAY_MS
    )
    expect(
      selectColdParkedTerminalTabs({
        worktreeId: WORKTREE_ID,
        terminalTabs: candidates,
        pendingStartupByTabId: {},
        parkingEnabled: true,
        nowMs: remountNowMs
      }).has(SUBSCRIBED_TAB_ID)
    ).toBe(true)
  })
})

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; connectionId?: string | null }
  ) => unknown
  issuePtyHandle: (pty: unknown) => string
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

// Gate daemon output on attach, independently of renderer presence.
function createHostProvider() {
  const ptyId = ptyIdFor(0)
  // Start attached, matching a pane viewed before it was hidden and parked.
  const session = { cols: 120, rows: 40, attached: true, screen: '' }
  const attachCalls: string[] = []
  const writes: [string, string][] = []
  let runtime: OrcaRuntimeService | null = null
  const controller = {
    write: (id: string, text: string) => {
      writes.push([id, text])
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [
      { id: ptyId, cwd: '/tmp/wt', worktreeId: WORKTREE_ID, title: '', cols: 120, rows: 40 }
    ],
    // Parking removes the renderer serializer visible to main.
    hasRendererSerializer: () => false,
    getSize: () => ({ cols: session.cols, rows: session.rows }),
    resize: () => true,
    attach: async (id: string) => {
      attachCalls.push(id)
      session.attached = true
      return true
    },
    serializeProviderBuffer: async () => ({
      data: session.screen,
      cols: session.cols,
      rows: session.rows,
      seq: 0,
      source: 'headless' as const
    })
  }
  return {
    ptyId,
    controller,
    attachCalls,
    writes,
    session,
    bind(target: OrcaRuntimeService) {
      runtime = target
    },
    emitData(data: string): boolean {
      if (!session.attached) {
        return false
      }
      session.screen += data
      runtime?.onPtyData(ptyId, data, Date.now())
      return true
    }
  }
}

function startMultiplex(runtime: OrcaRuntimeService, connectionId: string) {
  const messages: { result?: { type?: string; streamId?: number | null } }[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const request: RpcRequest = {
    id: `req-${connectionId}`,
    authToken: 'tok',
    method: 'terminal.multiplex',
    params: {}
  }
  const dispatchPromise = dispatcher.dispatchStreaming(
    request,
    (msg) => {
      messages.push(JSON.parse(msg))
    },
    {
      connectionId,
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => {
        binaryFrames.push(bytes)
        return true
      },
      registerBinaryStreamHandler: (
        streamId: number,
        handler: (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      ) => {
        handlers.set(streamId, handler)
        return () => {
          if (handlers.get(streamId) === handler) {
            handlers.delete(streamId)
          }
        }
      }
    }
  )
  return { messages, binaryFrames, handlers, dispatchPromise }
}

type Harness = ReturnType<typeof startMultiplex>

function sendSubscribe(harness: Harness, streamId: number, terminal: string, clientId: string) {
  harness.handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId,
          terminal,
          client: { id: clientId, type: 'desktop' }
        })
      })
    )!
  )
}

function sendInput(harness: Harness, streamId: number, text: string) {
  harness.handlers.get(streamId)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Input,
        streamId,
        seq: 2,
        payload: encodeTerminalStreamText(text)
      })
    )!
  )
}

async function waitForSubscribed(harness: Harness, streamId: number): Promise<void> {
  await vi.waitFor(() =>
    expect(
      harness.messages.some(
        (m) => m.result?.type === 'subscribed' && m.result?.streamId === streamId
      )
    ).toBe(true)
  )
}

function outputText(harness: Harness): string {
  return harness.binaryFrames
    .map(decodeTerminalStreamFrame)
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    .map((frame) => decodeTerminalStreamText(frame!.payload))
    .join('')
}

function errorFrames(harness: Harness): number {
  return harness.binaryFrames
    .map(decodeTerminalStreamFrame)
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.Error).length
}

describe('STA-2854 B: remote subscriber survives a fully unmounted host renderer', () => {
  it('streams, accepts input, and re-subscribes with no host renderer pane at all', async () => {
    const runtime = new OrcaRuntimeService()
    const provider = createHostProvider()
    provider.bind(runtime)
    runtime.setPtyController(provider.controller as never)
    const record = internals(runtime).recordPtyWorktree(provider.ptyId, WORKTREE_ID, {
      connected: true
    })
    const handle = internals(runtime).issuePtyHandle(record)
    // No authoritative window can mount a renderer, a stricter boundary than pane parking.
    const mountSpy = vi.spyOn(runtime, 'requestRendererTerminalTabMount').mockReturnValue(false)
    // Seed main’s model from an already-attached pane so subscription cannot reattach it.
    expect(provider.emitData('host pane was live\r\n')).toBe(true)

    const harness = startMultiplex(runtime, 'conn-client-b')
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    sendSubscribe(harness, 1, handle, 'client-b')
    await waitForSubscribed(harness, 1)

    expect(runtime.hasRemoteTerminalViewSubscriber(provider.ptyId)).toBe(true)
    // Raw subscriber presence vetoes daemon keep-tail thinning.
    expect(runtime.hasRawTerminalViewSubscriber(provider.ptyId)).toBe(true)

    expect(provider.emitData(`${MARKER_BEFORE_PARK}\r\n`)).toBe(true)
    await vi.waitFor(() => expect(outputText(harness)).toContain(MARKER_BEFORE_PARK))

    expect(provider.emitData(`${MARKER_AFTER_PARK}\r\n`)).toBe(true)
    await vi.waitFor(() => expect(outputText(harness)).toContain(MARKER_AFTER_PARK))

    sendInput(harness, 1, CLIENT_INPUT)
    await vi.waitFor(() => expect(provider.writes).toContainEqual([provider.ptyId, CLIENT_INPUT]))

    expect(provider.attachCalls).toEqual([])
    expect(errorFrames(harness)).toBe(0)
    expect(harness.messages.some((m) => m.result?.type === 'error')).toBe(false)

    const reconnected = startMultiplex(runtime, 'conn-client-b-2')
    await vi.waitFor(() => expect(reconnected.handlers.has(0)).toBe(true))
    sendSubscribe(reconnected, 1, handle, 'client-b')
    await waitForSubscribed(reconnected, 1)
    expect(provider.emitData(`${MARKER_AFTER_RECONNECT}\r\n`)).toBe(true)
    await vi.waitFor(() => expect(outputText(reconnected)).toContain(MARKER_AFTER_RECONNECT))

    // Neither subscribe nor reconnect may request a renderer mount once the leaf owns a PTY.
    expect(mountSpy).not.toHaveBeenCalled()
    expect(provider.attachCalls).toEqual([])
    expect(errorFrames(reconnected)).toBe(0)
  })

  it('counterfactual: losing every subscriber is what clears the thinning veto', async () => {
    const runtime = new OrcaRuntimeService()
    const provider = createHostProvider()
    provider.bind(runtime)
    runtime.setPtyController(provider.controller as never)
    const record = internals(runtime).recordPtyWorktree(provider.ptyId, WORKTREE_ID, {
      connected: true
    })
    const handle = internals(runtime).issuePtyHandle(record)
    vi.spyOn(runtime, 'requestRendererTerminalTabMount').mockReturnValue(false)

    const harness = startMultiplex(runtime, 'conn-counterfactual')
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribe(harness, 1, handle, 'client-b')
    await waitForSubscribed(harness, 1)
    expect(runtime.hasRawTerminalViewSubscriber(provider.ptyId)).toBe(true)

    harness.handlers.get(1)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 1,
          seq: 3,
          payload: encodeTerminalStreamJson({})
        })
      )!
    )
    await vi.waitFor(() => expect(runtime.hasRawTerminalViewSubscriber(provider.ptyId)).toBe(false))
    expect(provider.session.attached).toBe(true)
    expect(provider.emitData('post-unsubscribe\r\n')).toBe(true)
  })
})

describe('STA-2854 C: an unattached host PTY with no mountable renderer pane', () => {
  it('still streams to the remote subscriber without any renderer mount', async () => {
    const runtime = new OrcaRuntimeService()
    const provider = createHostProvider()
    // A never-mounted pane needs main to attach before daemon output can flow.
    provider.session.attached = false
    provider.bind(runtime)
    runtime.setPtyController(provider.controller as never)
    const record = internals(runtime).recordPtyWorktree(provider.ptyId, WORKTREE_ID, {
      connected: true
    })
    const handle = internals(runtime).issuePtyHandle(record)
    const mountSpy = vi.spyOn(runtime, 'requestRendererTerminalTabMount').mockReturnValue(false)

    const harness = startMultiplex(runtime, 'conn-client-c')
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    expect(provider.emitData('pre-subscribe\r\n')).toBe(false)

    sendSubscribe(harness, 1, handle, 'client-c')
    await waitForSubscribed(harness, 1)

    await vi.waitFor(() => expect(provider.attachCalls).toEqual([provider.ptyId]))
    expect(provider.emitData(`${MARKER_AFTER_PARK}\r\n`)).toBe(true)
    await vi.waitFor(() => expect(outputText(harness)).toContain(MARKER_AFTER_PARK))
    expect(mountSpy).not.toHaveBeenCalled()
    expect(errorFrames(harness)).toBe(0)
  })
})
