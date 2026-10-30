// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../../shared/clipboard-text'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'
import { installTerminalLinkPtyMouseSuppression } from './terminal-link-pty-mouse-suppression'
import { installTerminalLinkPointerGesture } from './terminal-link-pointer-gesture'
import { subscribeToTerminalInputData } from './terminal-user-input-signal'
import type { QualifiedPtyInputSession } from './pty-connection/pty-qualified-input-forwarder'
const store = vi.hoisted(() => ({
  getState: vi.fn(() => ({ codexRestartNoticeByPtyId: {}, agentStatusByPaneKey: {} }))
}))
vi.mock('@/store', () => ({ useAppStore: store }))
let callbacks: MultiplexSubscriptionCallbacks = null
let handle = 'terminal-1'
const h = createRemoteRuntimeTransportMocks({
  getCallbacks: () => callbacks,
  setCallbacks: (value) => {
    callbacks = value
  },
  getResolvedPaneHandle: () => handle,
  setResolvedPaneHandle: (value) => {
    handle = value
  }
})
const cleanup: (() => void)[] = []
afterEach(() => {
  cleanup
    .splice(0)
    .toReversed()
    .forEach((dispose) => dispose())
  vi.unstubAllGlobals()
})
async function open(revision?: number) {
  h.resetRemoteRuntimeTransport()
  if (revision !== undefined) {
    const authority = await import('@/runtime/runtime-environment-revision')
    authority.replaceRuntimeEnvironmentRevisions([
      { id: 'env-1', createdAt: 1, pairingRevision: revision }
    ])
  }
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  cleanup.push(() => transport.destroy?.())
  await transport.connect({ url: '', callbacks: {} })
  await vi.waitFor(() => expect(h.subscribeFrameCount()).toBe(1))
  const ack = (incarnationId: string): void =>
    callbacks?.onResponse({
      ok: true,
      result: {
        type: 'subscribed',
        streamId: h.latestSubscribePayload().streamId,
        terminal: handle,
        launchResult: { ptyId: 'pty', incarnationId }
      }
    })
  const unknown = transport.getInputSource?.()
  expect(unknown?.endpoint?.incarnationId).toBeNull()
  ack('i1')
  expect(transport.getInputSource?.()).toBe(unknown)
  expect(unknown?.endpoint?.incarnationId).toBe('i1')
  h.emitSnapshot(h.latestSubscribePayload().streamId, 'screen')
  return { transport, ack }
}

it.each(['same', 'replace'] as const)(
  'keeps original qualification and delayed scope through %s ACK validation/viewport/accepted/immediate handoffs',
  async (mode) => {
    const { transport, ack } = await open()
    h.runtimeCall.mockImplementation(async () => ({
      ok: true,
      result: { send: { accepted: true } }
    }))
    const { createQualifiedPtyInputForwarder } =
      await import('./pty-connection/pty-qualified-input-forwarder')
    const emulator = new Terminal({ allowProposedApi: true })
    const element = document.createElement('div')
    document.body.append(element)
    const tracker = installTerminalLinkPointerGesture({ element, hasSelection: () => false })
    const owner = installTerminalLinkPtyMouseSuppression(
      { element, clearSelection: vi.fn() },
      {
        candidate: () => 'same-rendered-range',
        eligible: tracker.canRequestAction,
        canContinue: tracker.canRequestAction
      }
    )
    const session: QualifiedPtyInputSession = {
      pane: { id: 1, terminal: emulator },
      deps: { tabId: 'tab-1', worktreeId: 'wt-1', replayingPanesRef: { current: new Map() } },
      transport,
      cacheKey: 'tab-1:pane:1',
      isNativeWindowsConpty: false,
      suppressNativeWindowsIdleCodexFocusReports: false,
      interruptStatusBaselineSequence: 0,
      sequencedInterruptStatusBaseline: null,
      interruptInference: { observeInputIntent: vi.fn() },
      cancelSuspendedShellCommandInference: vi.fn(),
      captureAgentPreReadyInput: vi.fn(() => false),
      claimViewportForUserActivity: vi.fn(),
      clearPendingTerminalInputIntent: vi.fn(),
      inferIntentFromExactTerminalInput: () => null,
      pendingTerminalInputIntentFor: () => null,
      markAcceptedTerminalInputSent: vi.fn(),
      observeAcceptedShellCommandInput: vi.fn(),
      observeAcceptedTerminalInput: vi.fn(),
      observeSentTerminalInputIntent: vi.fn(),
      observeTitleOnlyInterrupt: vi.fn(),
      requestRecoveryForUndeliverableInput: vi.fn(),
      sendDesktopQueryReplyImmediate: transport.sendInputImmediate,
      setPendingTerminalInputWrite: vi.fn()
    }
    const ordinary = createQualifiedPtyInputForwarder(session, null)
    const observation = transport.observeInputSource?.({
      beforeChange: owner.invalidateSource,
      afterChange: (source) => {
        const bound = createQualifiedPtyInputForwarder(session, source)
        owner.bindSource(
          source && {
            isCurrent: source.isCurrent,
            qualify: bound.qualify,
            user: bound.user,
            unclassified: bound.unclassified
          }
        )
      }
    })
    const input = subscribeToTerminalInputData(emulator, (data, user) =>
      owner.handlePtyInput(
        data,
        user ? ordinary.user : ordinary.unclassified,
        user,
        ordinary.qualify
      )
    )
    cleanup.push(() => {
      try {
        input.dispose()
        owner.dispose()
      } finally {
        observation?.dispose()
        tracker.dispose()
        emulator.dispose()
        element.remove()
      }
    })
    const down = '\x1b[<0;1;1M'
    const up = '\x1b[<0;1;1m'
    element.addEventListener('mousedown', () => emulator.input(down, true))
    element.addEventListener('mouseup', () => emulator.input(up, true))
    const a = transport.getInputSource?.()
    if (!a) {
      throw new Error('missing initial source')
    }
    const text = 'v'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS + 1)
    a.sendInput(text, 'driving')
    a.sendInputImmediate('immediate-A')
    const accepted = a.sendInputAccepted?.('accepted-A', 'driving')
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }))
    // Actual current response reconciles byte identity while launch attribution remains i1.
    ack(mode === 'replace' ? 'i2' : 'i1')
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const bytes = h.inputFrameTexts().join('')
    if (mode === 'replace') {
      expect(a.isCurrent()).toBe(false)
      await expect(accepted).resolves.toBe(false)
      expect(bytes).toBe('')
      expect(session.clearPendingTerminalInputIntent).not.toHaveBeenCalled()
      expect(session.claimViewportForUserActivity).not.toHaveBeenCalled()
      expect(session.markAcceptedTerminalInputSent).not.toHaveBeenCalled()
      expect(session.requestRecoveryForUndeliverableInput).not.toHaveBeenCalled()
    } else {
      expect(transport.getInputSource?.()).toBe(a)
      await expect(accepted).resolves.toBe(true)
      expect(bytes).toContain(text)
      expect(bytes).toContain('immediate-A')
      expect(h.runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.send',
          params: expect.objectContaining({ terminal: handle, text: 'accepted-A' })
        })
      )
      expect(bytes).toContain(down + up)
    }
    const b = transport.getInputSource?.()
    if (!b) {
      throw new Error('missing current source')
    }
    h.subscriptionSendBinary.mockClear()
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }))
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    emulator.input('ordinary-B', true)
    await vi.waitFor(() => expect(h.inputFrameTexts().join('')).toContain(down + up + 'ordinary-B'))
    expect(session.markAcceptedTerminalInputSent).toHaveBeenCalled()
    expect(session.requestRecoveryForUndeliverableInput).not.toHaveBeenCalled()
  }
)

it.each([10, 100])(
  'preserves real upstream batching bounds for %i ordinary/scoped/mixed writes',
  async (n) => {
    const { transport } = await open()
    const source = transport.getInputSource?.()
    if (!source) {
      throw new Error('missing current source')
    }
    for (const write of [
      () => transport.sendInput('x', 'driving'),
      () => source.sendInput('x', 'driving')
    ]) {
      h.subscriptionSendBinary.mockClear()
      for (let i = 0; i < n; i++) {
        expect(write()).toBe(true)
      }
      await vi.waitFor(() => expect(h.inputFrameTexts().join('')).toBe('x'.repeat(n)))
      expect(h.inputFrameTexts()).toHaveLength(1)
    }
    h.subscriptionSendBinary.mockClear()
    for (let i = 0; i < n; i++) {
      transport.sendInput('o', 'driving')
      source.sendInput('s', 'driving')
    }
    await vi.waitFor(() => expect(h.inputFrameTexts().join('')).toBe('os'.repeat(n)))
    expect(h.inputFrameTexts()).toHaveLength(2 * n)
  }
)

it.each([10, 100])(
  'advances normal proof once and adds no ordinary source work at N=%i',
  async (n) => {
    const { transport, ack } = await open(1)
    const revisions = await import('@/runtime/runtime-environment-revision')
    const source = transport.getInputSource?.()
    if (!source) {
      throw new Error('missing source')
    }
    expect(source.isCurrent()).toBe(true)
    // A same-host held source normalizes its existing proof before stream recovery/ACK.
    const producer = await import('@/store/slices/runtime-environment-peer-replacement')
    const managed = (revision: number, key: string | null = 'key') => ({
      id: 'env-1',
      createdAt: 1,
      pairingRevision: revision,
      ...(key === null ? {} : { hostKeyFingerprint: key }),
      orcadDeployment: {
        sshTargetId: 'box',
        sshTargetGeneration: 1,
        localPort: 46768,
        remotePort: 6768
      }
    })
    const original = managed(1)
    const pending = managed(2, null)
    revisions.replaceRuntimeEnvironmentRevisions(
      [pending],
      producer.classifyPeerReplacements(
        [original],
        [pending],
        producer.replacedRuntimeEnvironmentIds([original], [pending])
      )
    )
    expect(source.isCurrent()).toBe(false)
    const current = managed(2)
    revisions.replaceRuntimeEnvironmentRevisions(
      [current],
      producer.classifyPeerReplacements(
        [pending],
        [current],
        producer.replacedRuntimeEnvironmentIds([pending], [current])
      )
    )
    const resolve = vi.spyOn(revisions, 'resolveContinuedRuntimeEnvironmentRevision')
    const raw = vi.spyOn(revisions, 'getRuntimeEnvironmentRevision')
    for (let i = 0; i < n; i += 1) {
      expect(source.isCurrent()).toBe(true)
    }
    expect(resolve).toHaveBeenCalledTimes(n)
    expect(resolve.mock.calls[0]).toEqual(['env-1', 1])
    expect(resolve.mock.calls.slice(1).every(([, revision]) => revision === 2)).toBe(true)
    expect(raw).toHaveBeenCalledTimes(n)
    resolve.mockRestore()
    raw.mockRestore()
    await vi.waitFor(() => expect(h.subscribeFrameCount()).toBeGreaterThan(1))
    ack('i1')
    h.emitSnapshot(h.latestSubscribePayload().streamId, 'recovered')
    const ordinaryResolve = vi.spyOn(revisions, 'resolveContinuedRuntimeEnvironmentRevision')
    const ordinaryRaw = vi.spyOn(revisions, 'getRuntimeEnvironmentRevision')
    h.subscriptionSendBinary.mockClear()
    for (let i = 0; i < n; i += 1) {
      transport.sendInput('ordinary', 'driving')
    }
    await vi.waitFor(() => expect(h.inputFrameTexts().join('')).toBe('ordinary'.repeat(n)))
    expect(h.inputFrameTexts()).toHaveLength(1)
    expect(ordinaryResolve).not.toHaveBeenCalled()
    expect(ordinaryRaw).not.toHaveBeenCalled()
    ordinaryResolve.mockRestore()
    ordinaryRaw.mockRestore()
    producer.resetDeferredPeerChecksForTests()
  }
)

it('does not complete an old create against a successor after actual stream installation resumes', async () => {
  h.resetRemoteRuntimeTransport()
  const opening = Promise.withResolvers<{
    unsubscribe: () => void
    sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
  }>()
  h.runtimeSubscribe.mockImplementation(
    async (_args: unknown, next: NonNullable<MultiplexSubscriptionCallbacks>) => {
      callbacks = next
      queueMicrotask(h.emitMultiplexReady)
      return opening.promise
    }
  )
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'pane:1'
  })
  cleanup.push(() => transport.destroy?.())
  const initial = transport.connect({ url: '', callbacks: {} })
  try {
    await vi.waitFor(() => expect(h.runtimeSubscribe).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-1'))
    const old = transport.getInputSource?.()
    handle = 'terminal-2'
    transport.attach({ existingPtyId: 'remote:env-1@@terminal-2', callbacks: {} })
    await vi.waitFor(() => expect(transport.getPtyId()).toBe('remote:env-1@@terminal-2'))
    opening.resolve({ unsubscribe: () => {}, sendBinary: h.subscriptionSendBinary })
    await expect(initial).resolves.toBeUndefined()
    expect(old?.isCurrent()).toBe(false)
    await vi.waitFor(() => expect(h.subscribedTerminalHandles()).toContain('terminal-2'))
    callbacks?.onResponse({
      ok: true,
      result: {
        type: 'subscribed',
        streamId: h.latestSubscribePayload().streamId,
        terminal: 'terminal-2'
      }
    })
    h.emitSnapshot(h.latestSubscribePayload().streamId, 'B-screen')
    expect(transport.getInputSource?.()?.sendInput('B-positive', 'driving')).toBe(true)
    await vi.waitFor(() => expect(h.inputFrameTexts().join('')).toBe('B-positive'))
  } finally {
    opening.resolve({ unsubscribe: () => {}, sendBinary: h.subscriptionSendBinary })
    await initial
  }
})
