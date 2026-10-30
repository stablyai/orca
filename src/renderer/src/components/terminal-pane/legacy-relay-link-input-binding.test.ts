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
import { createPane, createManager } from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import type { StoreState } from './pty-connection-test-store-state'
import { PANE_PTY_RESIZE_HOLD_FLUSH_EVENT } from '@/lib/pane-manager/pane-pty-resize-hold'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'

const state = vi.hoisted(() => ({ codexRestartNoticeByPtyId: {}, agentStatusByPaneKey: {} }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('opens a direct link through a live legacy bridge and the real input-owner binding', async () => {
  const ptyId = 'ssh:box@@pty2:0360053e-409a-415b-8dee-dd911e8330ba:3'
  const url = 'https://example.com'
  const bridgeWrite = vi.fn()
  const doubles = createTerminalLinkTestDoubles()
  doubles.storeState.settings = { openLinksInApp: false, openLinksInAppPreferencePrompted: true }
  registerHttpLinkStoreAccessor(() => doubles.storeState)
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
  const actualWindow = window
  vi.stubGlobal('window', {
    api: {
      platform: { get: () => ({ platform: 'darwin' }) },
      shell: { openUrl: doubles.openUrlMock },
      legacyRelayBridge: {
        attach: vi.fn(async () => ({ status: 'attached', replay: url, acquisitionId: 1 })),
        detach: vi.fn(),
        write: bridgeWrite,
        onData: () => () => {},
        onReplay: () => () => {},
        onExit: () => () => {},
        onPanes: () => () => {},
        listPanes: vi.fn(async () => [])
      }
    },
    addEventListener: actualWindow.addEventListener.bind(actualWindow),
    removeEventListener: actualWindow.removeEventListener.bind(actualWindow)
  })
  const inner = createIpcPtyTransport()
  const transport = createLegacyRelayBridgeTransport(ptyId, inner)
  cleanup.push(
    () => transport.detach?.(),
    () => inner.detach?.()
  )
  await transport.connect({ url: '', sessionId: ptyId, callbacks: {} })
  expect(transport.isConnected()).toBe(true)
  expect(inner.getInputSource?.()).toBeNull()
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
  deps.paneTransportsRef.current.set(pane.id, transport)
  const session: ConnectPanePtySession = {
    pane,
    manager,
    deps,
    transport,
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
  emulator.input('ordinary-positive', true)
  expect(bridgeWrite).toHaveBeenCalledWith({ ptyId, data: 'ordinary-positive' })
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
})
