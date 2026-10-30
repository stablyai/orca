// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'
import { createLegacyRelayBridgeTransport } from './legacy-relay-bridge-transport'
import { createIpcPtyTransport } from './pty-transport'
import { installPtyInputForward } from './pty-connection/pty-input-forward'
import type { ConnectPanePtySession } from './pty-connection/connect-pane-pty-session'
import { TerminalIdleCursorReset } from './terminal-idle-cursor-reset'
import { installTerminalLinkPtyMouseSuppression } from './terminal-link-pty-mouse-suppression'
import { terminalLinkPressCandidate } from './terminal-link-press-candidate'
import { isTerminalLinkDirectActivation } from './terminal-link-activation'
import { handleTerminalHttpLink } from './terminal-url-link-hit-testing'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { createPane, createManager, LEAF_1 } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import type { StoreState } from './pty-connection-test-store-state'
import { PANE_PTY_RESIZE_HOLD_FLUSH_EVENT } from '@/lib/pane-manager/pane-pty-resize-hold'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import { createUnservedSshRowTransport } from './pty-connection/unserved-ssh-pane-connect'
import type * as InnerProjection from './legacy-relay-inner-input-source'
import type * as QualifiedForwarder from './pty-connection/pty-qualified-input-forwarder'
import type { LegacyRelayBridgedPane } from '../../../../shared/legacy-relay-bridge-contract'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

const allocation = vi.hoisted(() => ({ views: 0, forwarders: 0 }))
vi.mock('./legacy-relay-inner-input-source', async (original) => {
  const actual = await original<typeof InnerProjection>()
  return {
    ...actual,
    projectLegacyRelayInnerInputSource: (
      ...args: Parameters<typeof actual.projectLegacyRelayInnerInputSource>
    ) => {
      allocation.views++
      return actual.projectLegacyRelayInnerInputSource(...args)
    }
  }
})
vi.mock('./pty-connection/pty-qualified-input-forwarder', async (original) => {
  const actual = await original<typeof QualifiedForwarder>()
  return {
    ...actual,
    createQualifiedPtyInputForwarder: (
      ...args: Parameters<typeof actual.createQualifiedPtyInputForwarder>
    ) => {
      allocation.forwarders++
      return actual.createQualifiedPtyInputForwarder(...args)
    }
  }
})
const state = vi.hoisted(() => ({
  codexRestartNoticeByPtyId: {},
  agentStatusByPaneKey: {},
  sshConnectionStates: new Map([['box', { managedServer: { kind: 'relay', bridged: true } }]])
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['managed', 'unserved', 'recovered-inner'])(
  'opens a direct link through a live %s legacy bridge and the real input-owner binding',
  async (wrapper) => {
    const actualWindow = window
    const subscription: { callbacks: MultiplexSubscriptionCallbacks } = { callbacks: null }
    let handle = 'terminal-1'
    const runtime = createRemoteRuntimeTransportMocks({
      getCallbacks: () => subscription.callbacks,
      setCallbacks: (next) => {
        subscription.callbacks = next
      },
      getResolvedPaneHandle: () => handle,
      setResolvedPaneHandle: (next) => {
        handle = next
      }
    })
    if (wrapper === 'recovered-inner') {
      runtime.resetRemoteRuntimeTransport()
    }
    const ptyId = 'ssh:box@@pty2:0360053e-409a-415b-8dee-dd911e8330ba:3'
    const url = 'https://example.com'
    const bridgeWrite = vi.fn()
    const panes: LegacyRelayBridgedPane[] = [
      { ptyId, targetId: 'box', tabId: 'tab-1', leafId: LEAF_1, state: 'live' }
    ]
    const doubles = createTerminalLinkTestDoubles()
    doubles.storeState.settings = { openLinksInApp: false, openLinksInAppPreferencePrompted: true }
    registerHttpLinkStoreAccessor(() => doubles.storeState)
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtime.runtimeCall, subscribe: runtime.runtimeSubscribe },
        platform: { get: () => ({ platform: 'darwin' }) },
        shell: { openUrl: doubles.openUrlMock },
        legacyRelayBridge: {
          attach: vi.fn(async () => ({ status: 'attached', replay: url, acquisitionId: 1 })),
          detach: vi.fn(),
          write: bridgeWrite,
          onData: () => () => {},
          onReplay: () => () => {},
          onExit: () => () => {},
          onPanes: (listener: (value: LegacyRelayBridgedPane[]) => void) => {
            listener(panes)
            return () => {}
          },
          listPanes: vi.fn(async () => panes)
        }
      },
      addEventListener: actualWindow.addEventListener.bind(actualWindow),
      removeEventListener: actualWindow.removeEventListener.bind(actualWindow)
    })
    const inner =
      wrapper === 'recovered-inner'
        ? (await import('./remote-runtime-pty-transport')).createRemoteRuntimePtyTransport(
            'env-1',
            {
              worktreeId: 'wt-1',
              tabId: 'tab-1',
              leafId: LEAF_1
            }
          )
        : createIpcPtyTransport()
    const emulator = new Terminal({ allowProposedApi: true })
    const element = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    element.append(screen)
    document.body.append(element)
    vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 480))
    Object.defineProperty(emulator, 'element', { configurable: true, value: element })
    await new Promise<void>((resolve) => emulator.write(url, resolve))
    const clearSelection = vi.spyOn(emulator, 'clearSelection')
    const owner = installTerminalLinkPtyMouseSuppression(emulator, {
      candidate: (event) => terminalLinkPressCandidate(emulator, event, true),
      eligible: isTerminalLinkDirectActivation,
      canContinue: () => false
    })
    const store: StoreState = createInitialStoreState(() => store)
    const [pane, manager, deps] = mockPanePtyArgs(
      createPane(1),
      createManager(1),
      buildPaneConnectionDeps(() => store, {
        getPtyInputOwner: () => owner,
        isVisibleRef: { current: false }
      })
    )
    pane.terminal = emulator
    const session: ConnectPanePtySession = {
      pane,
      manager,
      deps,
      transport: inner,
      hiddenOutputRestoreUnhideSeq: null,
      idleCursorReset: new TerminalIdleCursorReset(),
      cacheKey: 'tab-1:pane:1',
      captureAgentPreReadyInput: () => false,
      clearPendingTerminalInputIntent: vi.fn(),
      pendingTerminalInputIntentFor: () => null,
      inferIntentFromExactTerminalInput: () => null,
      claimViewportForUserActivity: vi.fn(),
      markAcceptedTerminalInputSent: vi.fn(),
      observeAcceptedShellCommandInput: vi.fn(),
      observeAcceptedTerminalInput: vi.fn(),
      observeSentTerminalInputIntent: vi.fn(),
      requestRecoveryForUndeliverableInput: vi.fn()
    }
    const transport =
      wrapper === 'unserved'
        ? createUnservedSshRowTransport(session, 'box')
        : createLegacyRelayBridgeTransport(ptyId, inner)
    session.transport = transport
    deps.paneTransportsRef.current.set(pane.id, transport)
    cleanup.push(
      () => transport.detach?.(),
      () => inner.detach?.()
    )
    await transport.connect({
      url: '',
      sessionId: wrapper === 'recovered-inner' ? undefined : ptyId,
      callbacks: {}
    })
    const ack = (): void =>
      subscription.callbacks?.onResponse({
        ok: true,
        result: {
          type: 'subscribed',
          streamId: runtime.latestSubscribePayload().streamId,
          terminal: handle,
          launchResult: { ptyId: 'pty', incarnationId: 'i1' }
        }
      })
    if (wrapper === 'recovered-inner') {
      await vi.waitFor(() => expect(runtime.subscribeFrameCount()).toBe(1))
      ack()
      runtime.emitSnapshot(runtime.latestSubscribePayload().streamId, url)
      expect(transport.getInputSource?.()?.isCurrent()).toBe(true)
      expect(inner.getInputSource?.()?.endpoint?.incarnationId).toBe('i1')
    } else {
      expect(inner.getInputSource?.()).toBeNull()
    }
    expect(transport.isConnected()).toBe(true)
    installPtyInputForward(session)
    cleanup.push(() => {
      session.onDataDisposable.dispose()
      session.onResizeDisposable.dispose()
      session.imeCompositionRouteDisposable.dispose()
      session.terminalSelectionFitGuard.dispose()
      pane.container.removeEventListener(
        PANE_PTY_RESIZE_HOLD_FLUSH_EVENT,
        session.onHeldPtyResizeFlush
      )
      owner.dispose()
      emulator.dispose()
      element.remove()
    })
    if (wrapper === 'recovered-inner') {
      const sourceA = inner.getInputSource?.()
      const stableAllocation = { ...allocation }
      emulator.input('before-recovery', true)
      await vi.waitFor(() => expect(runtime.inputFrameTexts().join('')).toBe('before-recovery'))
      subscription.callbacks?.onError?.({
        code: 'remote_runtime_unavailable',
        message: 'Remote runtime connection closed.'
      })
      await vi.waitFor(() => expect(runtime.subscribeFrameCount()).toBe(2))
      ack()
      runtime.emitSnapshot(runtime.latestSubscribePayload().streamId, url)
      expect(inner.getInputSource?.()).toBe(sourceA)
      expect(sourceA?.isCurrent()).toBe(true)
      expect(sourceA?.endpoint?.incarnationId).toBe('i1')
      expect(allocation).toEqual(stableAllocation)
      runtime.subscriptionSendBinary.mockClear()
      emulator.input('ordinary-positive', true)
      await vi.waitFor(() => expect(runtime.inputFrameTexts().join('')).toBe('ordinary-positive'))
      runtime.subscriptionSendBinary.mockClear()
    } else {
      emulator.input('ordinary-positive', true)
      expect(bridgeWrite).toHaveBeenCalledWith({ ptyId, data: 'ordinary-positive' })
    }
    bridgeWrite.mockClear()
    element.addEventListener('mousedown', () => emulator.input('\x1b[<0;2;1M', true))
    let committed = false
    element.addEventListener('mouseup', (event) => {
      committed = handleTerminalHttpLink(url, event, {
        worktreeId: 'wt-1',
        sourceOwner: { kind: 'ssh', connectionId: 'box' },
        commit: owner.commit
      })
      emulator.input('\x1b[<0;2;1m', true)
    })
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      metaKey: true,
      clientX: 15,
      clientY: 5
    })
    expect(terminalLinkPressCandidate(emulator, down, true)).not.toBeNull()
    element.dispatchEvent(down)
    element.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 0,
        metaKey: true,
        clientX: 15,
        clientY: 5
      })
    )
    expect(committed).toBe(true)
    expect(clearSelection).toHaveBeenCalledOnce()
    expect(doubles.openUrlMock).toHaveBeenCalledExactlyOnceWith(url)
    expect(bridgeWrite).not.toHaveBeenCalled()
    expect(runtime.inputFrameTexts()).toEqual([])
    if (wrapper === 'recovered-inner') {
      const source = transport.getInputSource?.()
      const id = inner.getPtyId()
      if (!id) {
        throw new Error('Missing live remote pane')
      }
      const stableAllocation = { ...allocation }
      transport.attach({ existingPtyId: id, callbacks: {} })
      await vi.waitFor(() => expect(runtime.subscribeFrameCount()).toBe(1))
      ack()
      runtime.emitSnapshot(runtime.latestSubscribePayload().streamId, url)
      expect(transport.getInputSource?.()).toBe(source)
      expect(allocation).toEqual(stableAllocation)
      const readSource = vi.spyOn(inner, 'getInputSource')
      for (const n of [10, 100]) {
        runtime.subscriptionSendBinary.mockClear()
        readSource.mockClear()
        for (let i = 0; i < n; i++) {
          emulator.input('ordinary', true)
        }
        await vi.waitFor(() =>
          expect(runtime.inputFrameTexts().join('')).toBe('ordinary'.repeat(n))
        )
        expect(runtime.inputFrameTexts()).toHaveLength(1)
        expect(readSource).not.toHaveBeenCalled()
        expect(allocation).toEqual(stableAllocation)
      }
    }
  }
)
