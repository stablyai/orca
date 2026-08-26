/**
 * STA-2854 validation oracle (validation-only; no product change).
 *
 * Report: a host's renderer cold-parking policy ignores remote subscribers, so
 * a pane a paired client is actively viewing is unmounted 30s after it goes
 * locally hidden; reconnect remounts it without resetting the hidden clock, so
 * it re-parks immediately and the client never recovers.
 *
 * The report is two separable claims, so this file asserts them separately:
 *
 *   A. RENDERER POLICY — does host-local cold parking still ignore an active
 *      remote subscriber, and does a background (remote-subscribe-driven)
 *      mount still inherit a stale hidden clock?
 *   B. AUTHORITATIVE STREAM — does a parked host pane actually destroy the
 *      remote subscriber's stream, its input path, or its reconnect?
 *
 * B is modelled at the strictest possible park: a runtime with NO authoritative
 * window at all. That is strictly more unmounted than a cold-parked pane, so a
 * green B proves renderer parking cannot be the boundary that breaks the stream.
 */
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
/** Host-owned, snapshot-backed local daemon PTY: the exact shape the report's
 *  host had (a local pane a paired client was watching). */
const ptyIdFor = (n: number): string => `${WORKTREE_ID}@@aaaaaaa${n}`
const SUBSCRIBED_TAB_ID = 'tab-remote-viewed'
const MARKER_BEFORE_PARK = 'STA2854-BEFORE-PARK'
const MARKER_AFTER_PARK = 'STA2854-AFTER-PARK'
const MARKER_AFTER_RECONNECT = 'STA2854-AFTER-RECONNECT'
const CLIENT_INPUT = 'echo STA2854-INPUT\r'

// ---------------------------------------------------------------------------
// A. Host renderer cold-park policy (pure, explicit clock — no timers)
// ---------------------------------------------------------------------------

function tabModel(id: string, ptyId: string): TerminalTab {
  return { id, ptyId, generation: 1 } as unknown as TerminalTab
}

/** The report's topology, shrunk to the smallest set that still evicts:
 *  hot-retain limit + 1 hidden host tabs, one of them remotely subscribed. */
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

    // Pass 1: the host user switches away — every tab starts its hidden clock.
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
    // Eligible AND actually evicted: it is outside the hot-retain set.
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

    // Hours pass with the host untouched, then the client reconnects and the
    // host renderer background-mounts the tab. A background mount never makes
    // the tab locally visible, so it re-enters the candidate list with its
    // original hidden stamp — already past the hysteresis on the first pass.
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

// ---------------------------------------------------------------------------
// B. Authoritative host stream across the strictest possible park
// ---------------------------------------------------------------------------

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

/** Host-side provider: a local daemon session whose data events are gated on
 *  attach, exactly like the real daemon boundary. Never renderer-gated. */
function createHostProvider() {
  const ptyId = ptyIdFor(0)
  // Faithful to the report: the host pane WAS mounted (provider attached),
  // then went locally hidden and cold-parked.
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
    // A parked pane has no renderer serializer — this is the park, expressed
    // at the only boundary main can observe it from.
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
    // The park, at its strictest: no authoritative window exists, so a renderer
    // mount request is impossible — more unmounted than a cold-parked pane.
    const mountSpy = vi.spyOn(runtime, 'requestRendererTerminalTabMount').mockReturnValue(false)
    // The pane produced bytes while it was mounted, so main already owns model
    // state for it — no subscriber-driven (re)attach is in play.
    expect(provider.emitData('host pane was live\r\n')).toBe(true)

    const harness = startMultiplex(runtime, 'conn-client-b')
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    sendSubscribe(harness, 1, handle, 'client-b')
    await waitForSubscribed(harness, 1)

    // Two independent signals: authoritative subscriber presence AND bytes.
    expect(runtime.hasRemoteTerminalViewSubscriber(provider.ptyId)).toBe(true)
    // This is the exact input `syncPtyBackgroundedDelivery` reads to veto
    // daemon keep-tail thinning for a host-locally-hidden PTY.
    expect(runtime.hasRawTerminalViewSubscriber(provider.ptyId)).toBe(true)

    expect(provider.emitData(`${MARKER_BEFORE_PARK}\r\n`)).toBe(true)
    await vi.waitFor(() => expect(outputText(harness)).toContain(MARKER_BEFORE_PARK))

    // --- host cold-park episode: nothing about the pane exists on the host ---
    expect(provider.emitData(`${MARKER_AFTER_PARK}\r\n`)).toBe(true)
    await vi.waitFor(() => expect(outputText(harness)).toContain(MARKER_AFTER_PARK))

    // Input still reaches the authoritative PTY while fully unmounted.
    sendInput(harness, 1, CLIENT_INPUT)
    await vi.waitFor(() => expect(provider.writes).toContainEqual([provider.ptyId, CLIENT_INPUT]))

    // PTY identity never changed and the stream never errored.
    expect(provider.attachCalls).toEqual([])
    expect(errorFrames(harness)).toBe(0)
    expect(harness.messages.some((m) => m.result?.type === 'error')).toBe(false)

    // --- reconnect: a fresh connection re-subscribes with no mount available ---
    const reconnected = startMultiplex(runtime, 'conn-client-b-2')
    await vi.waitFor(() => expect(reconnected.handlers.has(0)).toBe(true))
    sendSubscribe(reconnected, 1, handle, 'client-b')
    await waitForSubscribed(reconnected, 1)
    expect(provider.emitData(`${MARKER_AFTER_RECONNECT}\r\n`)).toBe(true)
    await vi.waitFor(() => expect(outputText(reconnected)).toContain(MARKER_AFTER_RECONNECT))

    // Stronger than expected: subscribe and reconnect never even ASK for a
    // renderer mount once the leaf owns a PTY, so a re-park cannot cycle them.
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
    // The PTY itself is untouched: parking/unsubscribing never kills it.
    expect(provider.session.attached).toBe(true)
    expect(provider.emitData('post-unsubscribe\r\n')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// C. The path host parking really can starve: a host PTY main never attached
//    (never-activated or parked-from-birth tab) while no renderer can mount it.
// ---------------------------------------------------------------------------

describe('STA-2854 C: an unattached host PTY with no mountable renderer pane', () => {
  it('still streams to the remote subscriber without any renderer mount', async () => {
    const runtime = new OrcaRuntimeService()
    const provider = createHostProvider()
    // Parked/never-activated: no pane ever attached this daemon session, so the
    // provider is not emitting and only main can start it.
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
    // Baseline: the daemon refuses to emit for an unattached session.
    expect(provider.emitData('pre-subscribe\r\n')).toBe(false)

    sendSubscribe(harness, 1, handle, 'client-c')
    await waitForSubscribed(harness, 1)

    // Main itself must attach: the renderer cannot help while parked.
    await vi.waitFor(() => expect(provider.attachCalls).toEqual([provider.ptyId]))
    expect(provider.emitData(`${MARKER_AFTER_PARK}\r\n`)).toBe(true)
    await vi.waitFor(() => expect(outputText(harness)).toContain(MARKER_AFTER_PARK))
    expect(mountSpy).not.toHaveBeenCalled()
    expect(errorFrames(harness)).toBe(0)
  })
})
