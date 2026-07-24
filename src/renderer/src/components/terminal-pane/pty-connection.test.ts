/* oxlint-disable max-lines */
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
  POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
  POST_REPLAY_LIVE_SNAPSHOT_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_KITTY_KEYBOARD_PROTOCOL,
  RESET_TERMINAL_CURSOR_STYLE
} from './layout-serialization'
import { buildFreshShellViewportBlankingSequence } from './terminal-restored-viewport'
import { DEFAULT_DA1_RESPONSE } from './terminal-capability-replies'
import { TERMINAL_PASTE_DIRECT_MAX_BYTES } from './terminal-paste-coordinator'
import { resolveWindowsShiftEnterEncodingForPane } from './terminal-windows-shift-enter'
import type * as UseNotificationDispatchModule from './use-notification-dispatch'
import { getEagerPtyBufferHandle } from './pty-dispatcher'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { TerminalLayoutSnapshot, TuiAgent } from '../../../../shared/types'
import { YOLO_TUI_AGENT_ARGS } from '../../../../shared/tui-agent-permissions'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'
import {
  beginAgentStartupDeliveryAttempt,
  resetAgentStartupDelayedDeliveryForTests
} from '@/lib/agent-startup-delayed-delivery'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

// Repro command:
//   pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/pty-connection.test.ts -t "OpenTUI-style small ANSI redraw"

// Why: fresh-spawn/reattach now settle across multiple microtasks, so tests must drain several ticks before asserting on IPC mocks. See docs/mobile-prefer-renderer-scrollback.md.
async function flushAsyncTicks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve()
  }
}

async function drainPendingTimeouts(pendingTimeouts: (() => void)[], limit = 100): Promise<void> {
  let iterations = 0
  while (pendingTimeouts.length > 0) {
    if (iterations >= limit) {
      throw new Error('Timed out draining pending timeouts')
    }
    iterations += 1
    pendingTimeouts.shift()?.()
    await flushAsyncTicks()
  }
}

function writeHeadlessTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function renderHeadlessBuffer(writes: string[], cols = 80, rows = 8): Promise<string[]> {
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  try {
    for (const write of writes) {
      await writeHeadlessTerminal(term, write)
    }
    const lines: string[] = []
    for (let lineIndex = 0; lineIndex < term.buffer.active.length; lineIndex++) {
      lines.push(term.buffer.active.getLine(lineIndex)?.translateToString(true) ?? '')
    }
    return lines
  } finally {
    term.dispose()
  }
}

async function renderHeadlessTerminalState(
  writes: string[],
  cols = 80,
  rows = 8
): Promise<{ allLines: string[]; visibleLines: string[]; baseY: number }> {
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  try {
    for (const write of writes) {
      await writeHeadlessTerminal(term, write)
    }
    const allLines: string[] = []
    const buffer = term.buffer.active
    for (let lineIndex = 0; lineIndex < buffer.length; lineIndex++) {
      allLines.push(buffer.getLine(lineIndex)?.translateToString(true) ?? '')
    }
    const visibleLines: string[] = []
    for (let row = 0; row < term.rows; row++) {
      visibleLines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
    }
    return { allLines, visibleLines, baseY: buffer.baseY }
  } finally {
    term.dispose()
  }
}

const toastInfo = vi.fn()
const LEAF_1 = '11111111-1111-4111-8111-111111111111' as const
const LEAF_2 = '22222222-2222-4222-8222-222222222222' as const
const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS = 250
const AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS = 1_500

function leafIdForPane(paneId: number): string {
  return paneId === 2 ? LEAF_2 : LEAF_1
}

type StoreState = {
  activeWorktreeId: string | null
  tabsByWorktree: Record<
    string,
    {
      id: string
      ptyId: string | null
      title?: string
      launchAgent?: string
      shellOverride?: string
    }[]
  >
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  unreadTerminalTabs?: Record<string, true>
  deleteStateByWorktreeId?: Record<string, { isDeleting?: boolean; phase?: string }>
  worktreesByRepo: Record<
    string,
    {
      id: string
      repoId: string
      path: string
      displayName?: string
      branch?: string
      workspaceStatus?: string
      hostId?: string
      runtimeOwnerEnvironmentId?: string
    }[]
  >
  runtimeEnvironments?: { id: string }[]
  runtimeEnvironmentCatalogHydrated?: boolean
  repos: {
    id: string
    connectionId?: string | null
    displayName?: string
    executionHostId?: string | null
  }[]
  projects: {
    id: string
    localWindowsRuntimePreference?:
      | { kind: 'inherit-global' }
      | { kind: 'windows-host' }
      | { kind: 'wsl'; distro: string }
  }[]
  sshConnectionStates: Map<string, { status: string }>
  transientClearedAgentStatusConnectionIds: Record<string, true>
  cacheTimerByKey: Record<string, number | null>
  settings: {
    theme?: 'system' | 'dark' | 'light'
    promptCacheTimerEnabled?: boolean
    activeRuntimeEnvironmentId?: string | null
    experimentalTerminalAttention?: boolean
    terminalWindowsShell?: string
    terminalWindowsWslDistro?: string | null
    localWindowsRuntimeDefault?: { kind: 'windows-host' } | { kind: 'wsl'; distro: string | null }
    terminalMainSideEffectAuthority?: boolean
    terminalHiddenDeliveryGate?: boolean
    notifications?: {
      enabled?: boolean
      agentTaskComplete?: boolean
      terminalBell?: boolean
      suppressWhenFocused?: boolean
      customSoundPath?: string | null
    }
    agentCmdOverrides?: Record<string, string>
    agentDefaultArgs?: Record<string, string>
    agentDefaultEnv?: Record<string, Record<string, string>>
  } | null
  codexRestartNoticeByPtyId: Record<
    string,
    { previousAccountLabel: string; nextAccountLabel: string }
  >
  deferredSshReconnectTargets: string[]
  deferredSshSessionIdsByTabId: Record<string, string>
  removeDeferredSshReconnectTarget: ReturnType<typeof vi.fn>
  removeDeferredSshSessionId: ReturnType<typeof vi.fn>
  consumePendingColdRestore: ReturnType<typeof vi.fn>
  consumePendingSnapshot: ReturnType<typeof vi.fn>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  agentStatusByPaneKey: Record<string, unknown>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  sleepingAgentSessionsByPaneKey: Record<string, unknown>
  suppressedPtyExitIds: Record<string, true>
  agentLaunchConfigByPaneKey: Record<
    string,
    { launchConfig: unknown; identity?: { agentType?: string } }
  >
  getAgentLaunchConfigForStatusEntry: ReturnType<typeof vi.fn>
  getAgentLaunchConfigForStatusMetadata: ReturnType<typeof vi.fn>
  clearSleepingAgentSession: ReturnType<typeof vi.fn>
  registerAgentLaunchConfig: ReturnType<typeof vi.fn>
  clearAgentLaunchConfig: ReturnType<typeof vi.fn>
  markWorktreeUnread: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
  recordTerminalInput: ReturnType<typeof vi.fn>
  setAgentStatus: ReturnType<typeof vi.fn>
  removeAgentStatus: ReturnType<typeof vi.fn>
  dropAgentStatus: ReturnType<typeof vi.fn>
  retireAgentPaneAuthority: ReturnType<typeof vi.fn>
  setPaneForegroundAgent: ReturnType<typeof vi.fn>
  clearPaneForegroundAgent: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  markAgentCompletionPaneUnread: ReturnType<typeof vi.fn>
}

type WindowsShiftEnterPaneState = Parameters<typeof resolveWindowsShiftEnterEncodingForPane>[0]

function resolveMockPaneWindowsShiftEnterEncoding(
  state: StoreState,
  paneKey: string
): ReturnType<typeof resolveWindowsShiftEnterEncodingForPane> {
  return resolveWindowsShiftEnterEncodingForPane(
    {
      paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
      agentLaunchConfigByPaneKey:
        state.agentLaunchConfigByPaneKey as WindowsShiftEnterPaneState['agentLaunchConfigByPaneKey']
    },
    paneKey
  )
}

type ConnectCallbacks = {
  onConnect?: () => void
  onData?: (
    data: string,
    meta?: { seq?: number; rawLength?: number; background?: boolean; droppedOutput?: boolean }
  ) => void
  onReplayData?: (data: string, meta?: { clearBeforeReplay?: boolean }) => void
  onError?: (msg: string) => void
}

type MockTransport = {
  attach: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn> & {
    mockImplementation: (
      impl: (opts: { callbacks?: ConnectCallbacks } & Record<string, unknown>) => Promise<unknown>
    ) => unknown
  }
  sendInput: ReturnType<typeof vi.fn>
  sendInputImmediate: ReturnType<typeof vi.fn>
  sendInputAccepted?: ReturnType<typeof vi.fn>
  claimViewport: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  getPtyId: ReturnType<typeof vi.fn>
  getConnectionId: ReturnType<typeof vi.fn>
  serializeBuffer?: ReturnType<typeof vi.fn>
}

const scheduleRuntimeGraphSync = vi.fn()
const shouldSeedCacheTimerOnInitialTitle = vi.fn(() => false)
const scheduleTerminalWebglAtlasRecovery = vi.fn()

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

function notifyStoreSubscribers(): void {
  for (const listener of storeSubscribers.slice()) {
    listener(mockStoreState)
  }
}

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const isGeminiTerminalTitle = actual.isGeminiTerminalTitle as (title: string) => boolean
  return {
    ...actual,
    isGeminiTerminalTitle: vi.fn((title: string) => isGeminiTerminalTitle(title)),
    isClaudeAgent: vi.fn(() => false),
    detectAgentStatusFromTitle: vi.fn((title: string) => {
      if (/Claude (working|done)/.test(title)) {
        return /working/.test(title) ? 'working' : 'idle'
      }
      if (/Codex( working)?/.test(title)) {
        return /working/.test(title) ? 'working' : 'idle'
      }
      if (/^\s*(?:[\u2800-\u28ff]\s+)?(?:Pi|OMP)(?: ready| idle)?\s*$/i.test(title)) {
        return /[\u2800-\u28ff]/u.test(title) ? 'working' : 'idle'
      }
      return null
    })
  }
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createMockTransport(initialPtyId: string | null = null): MockTransport {
  let ptyId = initialPtyId
  const transport = {
    attach: vi.fn(({ existingPtyId }: { existingPtyId: string }) => {
      ptyId = existingPtyId
    }),
    connect: vi.fn().mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        ptyId = opts.sessionId
        return { id: opts.sessionId }
      }
      return ptyId
    }),
    sendInput: vi.fn(() => true),
    claimViewport: vi.fn(() => true),
    resize: vi.fn(() => true),
    getPtyId: vi.fn(() => ptyId),
    getConnectionId: vi.fn(() => null),
    serializeBuffer: undefined
  } as MockTransport
  const sendInput = transport.sendInput as unknown as (data: string) => boolean
  // Why: query replies route through sendInputImmediate; delegate to the same spy so reply-delivery assertions still observe them (#7329).
  transport.sendInputImmediate = vi.fn((data: string) => sendInput(data))
  transport.sendInputAccepted = vi.fn(async (data: string) => sendInput(data))
  return transport
}

function createPaneContainer(): HTMLElement {
  const container = new EventTarget() as HTMLElement
  Object.defineProperty(container, 'dataset', {
    configurable: true,
    value: {}
  })
  return container
}

function createPane(paneId: number) {
  const leafId = leafIdForPane(paneId)
  const activeBuffer = {
    type: 'normal' as const,
    viewportY: 0,
    baseY: 0,
    cursorY: 0,
    cursorX: 0
  }
  const terminal = {
    cols: 120,
    rows: 40,
    element: {},
    buffer: {
      active: activeBuffer
    },
    modes: {
      bracketedPasteMode: false,
      sendFocusMode: false
    },
    options: {
      scrollback: 5_000,
      ignoreBracketedPasteMode: false,
      theme: {
        foreground: '#eeeeee',
        background: '#111111'
      }
    },
    write: vi.fn<(data: string, callback?: () => void) => void>(function write(...args): void {
      const [data, callback] = args
      if (data === '' || callback?.name === 'runParsedSteps') {
        callback?.()
      }
    }),
    resize: vi.fn(),
    clear: vi.fn(),
    scrollToBottom: vi.fn(() => {
      activeBuffer.viewportY = activeBuffer.baseY
    }),
    scrollToLine: vi.fn((line: number) => {
      activeBuffer.viewportY = line
    }),
    scrollLines: vi.fn((amount: number) => {
      activeBuffer.viewportY = Math.max(
        0,
        Math.min(activeBuffer.baseY, activeBuffer.viewportY + amount)
      )
    }),
    paste: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    onRender: vi.fn((_listener: () => void) => ({ dispose: vi.fn() })),
    onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
    hasSelection: vi.fn(() => false),
    parser: {
      registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
      registerOscHandler: vi.fn(() => ({ dispose: vi.fn() }))
    }
  }
  return {
    id: paneId,
    leafId,
    stablePaneId: leafId,
    terminal,
    container: createPaneContainer(),
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: terminal.cols, rows: terminal.rows }))
    }
  }
}

function captureCallbackTerminalWrites(pane: ReturnType<typeof createPane>): {
  writes: string[]
  parseCallbacks: (() => void)[]
} {
  const writes: string[] = []
  const parseCallbacks: (() => void)[] = []
  pane.terminal.write = function write(data: string, callback?: () => void): void {
    writes.push(data)
    if (callback) {
      parseCallbacks.push(callback)
    }
  } as typeof pane.terminal.write
  return { writes, parseCallbacks }
}

function createManager(paneCount = 1, initialActivePaneId: number | null = null) {
  let activePaneId = initialActivePaneId
  const panes = Array.from({ length: paneCount }, (_, index) => ({
    id: index + 1,
    leafId: leafIdForPane(index + 1)
  }))
  return {
    setPaneGpuRendering: vi.fn(),
    markPaneHasComplexScriptOutput: vi.fn(),
    rebuildPaneWebgl: vi.fn(),
    hasWebglRenderer: vi.fn(() => false),
    getPanes: vi.fn(() => panes),
    closePane: vi.fn(),
    getActivePane: vi.fn<() => { id: number; leafId?: string } | null>(() =>
      activePaneId === null
        ? null
        : (panes.find((candidate) => candidate.id === activePaneId) ?? null)
    ),
    getNumericIdForLeaf: vi.fn((leafId: string) => {
      return panes.find((candidate) => candidate.leafId === leafId)?.id ?? null
    }),
    setActivePane: vi.fn((paneId: number) => {
      activePaneId = paneId
    })
  }
}

function createDeps(overrides: Record<string, unknown> = {}) {
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    cwd: '/tmp/wt-1',
    startup: null,
    restoredLeafId: null,
    restoredPtyIdByLeafId: {},
    paneTransportsRef: { current: new Map() },
    paneMode2031Ref: { current: new Map() },
    paneKittyKeyboardModesRef: { current: new Map() },
    paneLastThemeModeRef: { current: new Map() },
    replayingPanesRef: { current: new Map() },
    isActiveRef: { current: true },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    onAgentExitedRef: { current: vi.fn() },
    onPtyErrorRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(() => false),
    isPtyShutdownPending: vi.fn(() => false),
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: vi.fn((tabId: string, ptyId: string, replacedPtyId?: string) => {
      const current = mockStoreState.ptyIdsByTabId?.[tabId] ?? []
      const next =
        replacedPtyId && current.includes(replacedPtyId)
          ? current.map((candidate) => (candidate === replacedPtyId ? ptyId : candidate))
          : current.includes(ptyId)
            ? current
            : [...current, ptyId]
      mockStoreState.ptyIdsByTabId = { ...mockStoreState.ptyIdsByTabId, [tabId]: next }
    }),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    clearWorktreeUnread: vi.fn(),
    clearTerminalTabUnread: vi.fn(),
    clearTerminalPaneUnread: vi.fn(),
    dispatchNotification: vi.fn(),
    onShowSessionRestoredBanner: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn((paneId: number, ptyId: string) => {
      const layout = mockStoreState.terminalLayoutsByTabId?.['tab-1']
      if (layout) {
        layout.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId, [leafIdForPane(paneId)]: ptyId }
      }
    }),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    ...overrides
  }
}

function setReattachPaneTitle(title: string): void {
  mockStoreState = {
    ...mockStoreState,
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', title }]
    },
    runtimePaneTitlesByTabId: {
      'tab-1': { 1: title }
    }
  } as StoreState
}

async function withMockedDocumentActiveElement<T>(
  activeElement: unknown,
  run: () => Promise<T>
): Promise<T> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { activeElement }
  })
  try {
    return await run()
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument)
    } else {
      Reflect.deleteProperty(globalThis, 'document')
    }
  }
}

function configureTerminalFocusMode(
  pane: ReturnType<typeof createPane>,
  textarea: HTMLTextAreaElement
): void {
  Object.assign(pane.terminal, { textarea })
  Object.assign(pane.terminal.modes, { sendFocusMode: true })
  pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
    callback?.()
  })
}

const ANSI_POSITIONED_CURSOR_AGENT_REATTACH_SCREEN =
  '\x1b[4;3HCursor Agent\x1b[5;3Hv2026.06.29\x1b[9;3H→ Plan, search, build anything'

// Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
  mockStoreState = {
    ...mockStoreState,
    settings: {
      ...mockStoreState.settings,
      activeRuntimeEnvironmentId: environmentId
    }
  } as StoreState
}

function createKeyboardEventTarget() {
  const handlers = new Set<(event: KeyboardEvent) => void>()
  return {
    handlers,
    target: {
      addEventListener: vi.fn(
        (
          type: string,
          handler: EventListenerOrEventListenerObject,
          _options?: AddEventListenerOptions | boolean
        ) => {
          if (type === 'keydown' && typeof handler === 'function') {
            handlers.add(handler as (event: KeyboardEvent) => void)
          }
        }
      ),
      removeEventListener: vi.fn(
        (
          type: string,
          handler: EventListenerOrEventListenerObject,
          _options?: EventListenerOptions | boolean
        ) => {
          if (type === 'keydown' && typeof handler === 'function') {
            handlers.delete(handler as (event: KeyboardEvent) => void)
          }
        }
      )
    },
    dispatch(event: KeyboardEvent) {
      for (const handler of handlers) {
        handler(event)
      }
    }
  }
}

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  } as KeyboardEvent
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve
  })
  return { promise, resolve: resolveDeferred }
}

function createRect(width: number, height: number, left = 0, top = 0): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  } as DOMRect
}

function stubElementRect(element: HTMLElement, readRect: () => DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: vi.fn(readRect)
  })
}

function createMeasuredElement(args: {
  className?: () => string
  parentElement?: () => HTMLElement | null
  rect: () => DOMRect
}): HTMLElement {
  const element = new EventTarget() as HTMLElement
  Object.defineProperty(element, 'dataset', {
    configurable: true,
    value: {}
  })
  Object.defineProperty(element, 'classList', {
    configurable: true,
    value: {
      contains: (className: string): boolean =>
        (args.className?.() ?? '').split(/\s+/).includes(className)
    }
  })
  Object.defineProperty(element, 'parentElement', {
    configurable: true,
    get: () => args.parentElement?.() ?? null
  })
  stubElementRect(element, args.rect)
  return element
}

function temporarilySetNavigatorUserAgent(userAgent: string): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const platform = userAgent.includes('Windows')
    ? 'Win32'
    : userAgent.includes('Macintosh')
      ? 'MacIntel'
      : 'Linux x86_64'
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform, userAgent }
  })
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalDescriptor)
    } else {
      delete (globalThis as { navigator?: Navigator }).navigator
    }
  }
}

function sendTerminalInputThroughPane(pane: ReturnType<typeof createPane>, data: string): void {
  const onDataMock = pane.terminal.onData as unknown as {
    mock: { calls: [[(data: string) => void] | []] }
  }
  const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
  expect(terminalInputHandler).toBeTypeOf('function')
  terminalInputHandler?.(data)
}

describe('connectPanePty', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
  const originalDocument = globalThis.document

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = {
      activeWorktreeId: 'wt-1',
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['tab-pty']
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: 'tab-pty' }
        }
      },
      unreadTerminalTabs: {},
      deleteStateByWorktreeId: {},
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', displayName: 'feat/notis' }]
      },
      repos: [{ id: 'repo1', connectionId: null, displayName: 'orca' }],
      projects: [],
      sshConnectionStates: new Map(),
      transientClearedAgentStatusConnectionIds: {},
      cacheTimerByKey: {},
      // Why: terminalMainSideEffectAuthority false pins the legacy renderer byte-parser wiring this suite asserts on (onTitleChange/onBell); authority-on mode has its own tests.
      settings: {
        promptCacheTimerEnabled: true,
        experimentalTerminalAttention: true,
        terminalMainSideEffectAuthority: false
      },
      codexRestartNoticeByPtyId: {},
      deferredSshReconnectTargets: [],
      deferredSshSessionIdsByTabId: {},
      removeDeferredSshReconnectTarget: vi.fn(),
      removeDeferredSshSessionId: vi.fn(),
      consumePendingColdRestore: vi.fn(() => null),
      consumePendingSnapshot: vi.fn(() => null),
      runtimePaneTitlesByTabId: {},
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      suppressedPtyExitIds: {},
      agentLaunchConfigByPaneKey: {},
      getAgentLaunchConfigForStatusEntry: vi.fn((entry: { paneKey: string }) => {
        return mockStoreState.agentLaunchConfigByPaneKey[entry.paneKey]?.launchConfig
      }),
      getAgentLaunchConfigForStatusMetadata: vi.fn(
        (metadata: { paneKey: string; launchToken?: string }) => {
          return metadata.launchToken
            ? mockStoreState.agentLaunchConfigByPaneKey[metadata.paneKey]?.launchConfig
            : undefined
        }
      ),
      clearSleepingAgentSession: vi.fn((paneKey: string) => {
        delete mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]
      }),
      registerAgentLaunchConfig: vi.fn(),
      clearAgentLaunchConfig: vi.fn(),
      markWorktreeUnread: vi.fn(),
      observeTerminalGitHubPullRequestLink: vi.fn(),
      recordTerminalInput: vi.fn(),
      setAgentStatus: vi.fn(
        (
          paneKey: string,
          payload: Record<string, unknown>,
          terminalTitle?: string | null,
          _timing?: unknown,
          routing?: { connectionId?: string | null }
        ) => {
          mockStoreState.agentStatusByPaneKey[paneKey] = {
            ...payload,
            paneKey,
            ...(terminalTitle ? { terminalTitle } : {}),
            ...(routing?.connectionId !== undefined ? { connectionId: routing.connectionId } : {}),
            updatedAt: Date.now(),
            stateStartedAt: Date.now(),
            stateHistory: []
          }
        }
      ),
      removeAgentStatus: vi.fn(),
      dropAgentStatus: vi.fn(),
      retireAgentPaneAuthority: vi.fn(),
      setPaneForegroundAgent: vi.fn((paneKey: string, entry: PaneForegroundAgentEntry) => {
        mockStoreState.paneForegroundAgentByPaneKey[paneKey] = entry
      }),
      clearPaneForegroundAgent: vi.fn((paneKey: string) => {
        delete mockStoreState.paneForegroundAgentByPaneKey[paneKey]
      }),
      markTerminalTabUnread: vi.fn(),
      markTerminalPaneUnread: vi.fn(),
      markAgentCompletionPaneUnread: vi.fn()
    } as StoreState
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        ssh: {
          connect: vi.fn().mockResolvedValue({ status: 'connected' }),
          needsPassphrasePrompt: vi.fn().mockResolvedValue(false)
        },
        pty: {
          signal: vi.fn(),
          listSessions: vi.fn().mockResolvedValue([]),
          hasPty: vi.fn().mockResolvedValue(true),
          getSize: vi.fn().mockResolvedValue(null),
          reportGeometry: vi.fn(),
          getMainBufferSnapshot: vi.fn().mockResolvedValue(null),
          getForegroundProcess: vi.fn().mockResolvedValue(null),
          inspectProcess: vi.fn(),
          confirmForegroundProcess: vi.fn().mockResolvedValue(null),
          hasChildProcesses: vi.fn().mockResolvedValue(false),
          write: vi.fn(),
          writeAccepted: vi.fn().mockResolvedValue(true),
          setHiddenRendererPty: vi.fn(),
          setPtyDeliveryInterest: vi.fn(),
          ackColdRestore: vi.fn(),
          onClearBufferRequest: vi.fn(() => vi.fn()),
          onSerializeBufferRequest: vi.fn(() => vi.fn()),
          sendSerializedBuffer: vi.fn(),
          declarePendingPaneSerializer: vi.fn().mockResolvedValue(1),
          settlePaneSerializer: vi.fn().mockResolvedValue(undefined),
          clearPendingPaneSerializer: vi.fn().mockResolvedValue(undefined),
          reportRendererSerializerReady: vi.fn().mockResolvedValue(undefined)
        },
        platform: {
          get: vi.fn(() => ({ platform: 'win32', osRelease: '10.0.26100' }))
        },
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true }),
          playSound: vi.fn().mockResolvedValue({ played: true })
        },
        runtime: {
          restoreTerminalFit: vi.fn().mockResolvedValue({ restored: true })
        },
        agentStatus: {
          inferInterrupt: vi.fn().mockResolvedValue(false)
        }
      },
      dispatchEvent: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation((id) =>
      window.api.pty.getForegroundProcess(id)
    )
    vi.mocked(window.api.pty.inspectProcess).mockImplementation(async (id) => {
      const foregroundProcess = await window.api.pty.getForegroundProcess(id)
      const hasChildProcesses = await window.api.pty.hasChildProcesses(id)
      return { foregroundProcess, hasChildProcesses }
    })
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    globalThis.cancelAnimationFrame = vi.fn()
  })

  afterEach(async () => {
    // Why: drain in-flight foreground-confirm microtasks while this test still owns the store mock, so its async fallout can't leak into (and flake) the next test.
    await flushAsyncTicks()
    vi.useRealTimers()
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
    } else {
      delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame })
        .requestAnimationFrame
    }
    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
    } else {
      delete (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame })
        .cancelAnimationFrame
    }
    if (originalDocument) {
      globalThis.document = originalDocument
    } else {
      delete (globalThis as { document?: Document }).document
    }
    delete (globalThis as unknown as { window?: unknown }).window
    delete (globalThis as Record<string, unknown>).__ptyConnectDiag
    resetAgentStartupDelayedDeliveryForTests()
  })

  it('does not retain PTY connect diagnostics unless e2e debug state is enabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    expect((globalThis as Record<string, unknown>).__ptyConnectDiag).toBeUndefined()
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('[pty-connect]'))
    logSpy.mockRestore()
  }, 30_000)

  // Why: hidden panes (orchestration workers, CLI terminal create) legitimately connect at 0×0 and refit when shown, so the zero-dimensions diagnostic must stay silent.
  it('does not surface the zero-dimensions diagnostic for a hidden pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.cols = 0
    pane.terminal.rows = 0
    const deps = createDeps({ isVisibleRef: { current: false } })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('still surfaces the zero-dimensions diagnostic for a visible pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.cols = 0
    pane.terminal.rows = 0
    const deps = createDeps({ isVisibleRef: { current: true } })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
      pane.id,
      expect.stringContaining('Terminal has zero dimensions (0×0)')
    )
  })

  // Why: a late exit from a replaced PTY skips onExit's kitty reset, so a fresh spawn must reset the reused per-pane tracker itself or restart-in-place leaks old kitty flags.
  it('resets a stale kitty keyboard mirror when spawning a fresh PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { TerminalKittyKeyboardModeTracker } =
      await import('../../../../shared/terminal-kitty-keyboard-mode-tracker')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const staleTracker = new TerminalKittyKeyboardModeTracker()
    staleTracker.scan('\x1b[>1u')
    expect(staleTracker.flags).toBe(1)
    // Why: a unique tab id keeps this pane's key clear of other tests' pendingSpawnByPaneKey entries so the connect deterministically fresh-spawns.
    const deps = createDeps({
      tabId: 'tab-kitty-fresh-spawn',
      paneKittyKeyboardModesRef: { current: new Map([[91, staleTracker]]) }
    })

    connectPanePty(createPane(91) as never, createManager(91) as never, deps as never)
    await flushAsyncTicks()

    expect(staleTracker.flags).toBe(0)
  })

  // Why: deleting a worktree kills its PTYs for the filesystem teardown; the
  // renderer must not race a doomed respawn into a directory main is deleting
  // (main fences it with TerminalRemovalInProgressError and the pane is about to
  // unmount). See docs — bad UI was the raw fence error flashing on the tab.
  it('skips a fresh spawn while the pane worktree is being deleted', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      deleteStateByWorktreeId: { 'wt-1': { isDeleting: true, phase: 'deleting' } }
    }
    // Why: a unique tab id keeps this pane's key clear of other tests' pendingSpawnByPaneKey entries so the connect deterministically fresh-spawns.
    const deps = createDeps({ tabId: 'tab-removal-skip-spawn' })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('fresh-spawns normally when the pane worktree is not being deleted', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    // Why: unique tab id → deterministic fresh spawn (mirrors the skip test's control).
    const deps = createDeps({ tabId: 'tab-removal-control-spawn' })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.connect).toHaveBeenCalled()
  })

  // Why: a doomed pane (or a child pane whose parent worktree is being removed,
  // which startFreshSpawn's own-worktree skip cannot see) can still race a spawn
  // that main fences. reportError must swallow that fence so the tab never flashes
  // the raw "Terminal cannot start while the worktree is being removed" banner.
  it('swallows a worktree-removal fence error instead of surfacing it', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE } =
      await import('../../../../shared/worktree-removal-fence-error')
    const transport = createMockTransport()
    const capturedOnError: { current: ((message: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedOnError.current = callbacks.onError ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)
    const deps = createDeps({ tabId: 'tab-fence-swallow' })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    // Why: assert the callback was captured before invoking — optional invocation
    // would let this test false-pass (not.toHaveBeenCalled trivially true) if the
    // transport onError wiring ever broke, exercising no suppression at all.
    expect(capturedOnError.current).toBeTypeOf('function')
    // Electron wraps the rejected ipcMain error with its own prefix; still swallowed.
    capturedOnError.current!(
      `Error invoking remote method 'pty:spawn': Error: ${TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE}`
    )
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('still surfaces non-fence spawn errors through the pane error sink', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedOnError: { current: ((message: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedOnError.current = callbacks.onError ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)
    const deps = createDeps({ tabId: 'tab-real-error-surface' })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(capturedOnError.current).toBeTypeOf('function')
    capturedOnError.current!('shell exited with code 1')
    expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(1, 'shell exited with code 1')
  })

  it('threads the resolved local project runtime into IPC terminal transport options', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: {
        ...mockStoreState.settings,
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' }
      },
      projects: [{ id: 'repo1', localWindowsRuntimePreference: { kind: 'windows-host' } }]
    }

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    expect(createdTransportOptions[0]?.projectRuntime).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: 'repo1',
        reason: 'project-override',
        cacheKey: 'repo1:windows-host'
      }
    })
  })

  it('observes live terminal GitHub PR URLs before agent completion', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()

    capturedDataCallback.current?.('Created https://github.com/acme/orca/pull/42\r\n')

    expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        url: 'https://github.com/acme/orca/pull/42',
        slug: { owner: 'acme', repo: 'orca', host: 'github.com' },
        number: 42
      })
    )
  })

  it('drops keystrokes while the replay guard is engaged, then forwards once it releases', async () => {
    // Regression (cold-restore reattach lockout): a stuck replay guard dropped every keystroke ("can't type after reconnecting"); engaged guard suppresses input, released forwards it.
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('ssh:ssh-1@@pty-1')
    transportFactoryQueue.push(transport)
    const deps = createDeps()

    connectPanePty(pane as never, createManager(1, 1) as never, deps as never)
    await flushAsyncTicks()

    transport.sendInput.mockClear()
    // Engaged (as a stuck reattach would leave it): input must be suppressed.
    deps.replayingPanesRef.current.set(pane.id, 3)
    sendTerminalInputThroughPane(pane, 'echo hi\r')
    expect(transport.sendInput).not.toHaveBeenCalled()

    // Released (via the guard's fallback or parse completion): input flows again.
    deps.replayingPanesRef.current.delete(pane.id)
    sendTerminalInputThroughPane(pane, 'echo hi\r')
    expect(transport.sendInput).toHaveBeenCalledWith('echo hi\r')
  })

  it('normalizes Pi-compatible remote runtime status to OMP after typed omp command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-omp')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'omp\r')
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(transport.sendInput).toHaveBeenCalledWith('omp\r')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'OMP ready')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'OMP ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('drives runtime title, tab title, and renderer policy from one title decision', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-gemini')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!onTitleChange) {
      throw new Error('missing title callback')
    }
    onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

    // Display/runtime/tab title and the GPU gate all come from the same decision.
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, '✦ Gemini CLI')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', '✦ Gemini CLI')
    // Genuine Gemini under the default `auto` setting takes the DOM fallback.
    expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
  })

  it('keeps GPU enabled when a pane-scoped OMP owner emits a Gemini-looking title', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          agentType: 'omp',
          state: 'working',
          prompt: '',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          stateHistory: []
        }
      }
    } as StoreState
    const pane = createPane(1)
    const transport = createMockTransport('pty-omp-gemini-cwd')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!onTitleChange) {
      throw new Error('missing title callback')
    }
    onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

    // Pane-scoped owner evidence outranks the raw title, so the fallback cannot fire.
    expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, true)
    expect(manager.setPaneGpuRendering).not.toHaveBeenCalledWith(1, false)
  })

  it('does not let one split pane title change another pane GPU state', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane1 = createPane(1)
    const pane2 = createPane(2)
    const transport1 = createMockTransport('pty-split-1')
    const transport2 = createMockTransport('pty-split-2')
    transportFactoryQueue.push(transport1, transport2)
    const manager = createManager(2, 1)

    connectPanePty(pane1 as never, manager as never, createDeps() as never)
    connectPanePty(pane2 as never, manager as never, createDeps() as never)
    await flushAsyncTicks()
    const onTitleChange1 = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!onTitleChange1) {
      throw new Error('missing title callback for split pane 1')
    }
    onTitleChange1('✦ Gemini CLI', '✦ Gemini CLI')

    const gpuCalls = manager.setPaneGpuRendering.mock.calls as [number, boolean][]
    expect(gpuCalls.some(([paneId]) => paneId === 1)).toBe(true)
    expect(gpuCalls.every(([paneId]) => paneId !== 2)).toBe(true)
  })

  it('DOM-gates a genuine Gemini split pane even when the tab launched a non-Gemini agent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    // The shared tab.launchAgent must not veto the renderer for a sibling pane.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', launchAgent: 'omp' }]
      }
    } as StoreState
    const pane1 = createPane(1)
    const pane2 = createPane(2)
    const transport1 = createMockTransport('pty-split-owner-1')
    const transport2 = createMockTransport('pty-split-owner-2')
    transportFactoryQueue.push(transport1, transport2)
    const manager = createManager(2, 2)

    connectPanePty(pane1 as never, manager as never, createDeps() as never)
    connectPanePty(pane2 as never, manager as never, createDeps() as never)
    await flushAsyncTicks()
    const onTitleChange2 = createdTransportOptions[1]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!onTitleChange2) {
      throw new Error('missing title callback for split pane 2')
    }
    onTitleChange2('✦ Gemini CLI', '✦ Gemini CLI')

    expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(2, false)
  })

  it('DOM-gates a genuine Gemini title in a pane whose launch agent was non-Gemini', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-reused-gemini')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    // Stale, never-cleared launch identity must not veto the renderer.
    const deps = createDeps({ startup: { command: 'claude', launchAgent: 'claude' } })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!onTitleChange) {
      throw new Error('missing title callback')
    }
    onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

    expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
  })

  it('DOM-gates a genuine Gemini title when the only pane row is a done non-Gemini agent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          agentType: 'claude',
          state: 'done',
          prompt: '',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          stateHistory: []
        }
      }
    } as StoreState
    const pane = createPane(1)
    const transport = createMockTransport('pty-reused-done-row')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!onTitleChange) {
      throw new Error('missing title callback')
    }
    onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

    // A `done` row is a leftover from a prior agent, so it must not veto.
    expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
  })

  it('DOM-gates a genuine Gemini title when the only pane row is a stale non-Gemini agent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const staleAt = Date.now() - 60 * 60 * 1000
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          agentType: 'claude',
          state: 'working',
          prompt: '',
          updatedAt: staleAt,
          stateStartedAt: staleAt,
          stateHistory: []
        }
      }
    } as StoreState
    const pane = createPane(1)
    const transport = createMockTransport('pty-reused-stale-row')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!onTitleChange) {
      throw new Error('missing title callback')
    }
    onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

    // A stale working row (older than AGENT_STATUS_STALE_AFTER_MS) must not veto.
    expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
  })

  it('normalizes after shell word deletion edits a typed command to omp', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-omp-edited')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'pi \x17omp\r')
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(transport.sendInput).toHaveBeenCalledWith('pi \x17omp\r')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'OMP ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('keeps Pi-compatible remote runtime status as Pi after typed pi command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-pi')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'pi\r')
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(transport.sendInput).toHaveBeenCalledWith('pi\r')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Pi ready')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Pi ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'pi',
      terminalTitle: 'Pi ready'
    })
  })

  it('does not infer shell ownership from prompts typed inside an existing Pi session', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const now = Date.now()
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: '',
      agentType: 'pi',
      paneKey,
      terminalTitle: 'Pi ready',
      updatedAt: now,
      stateStartedAt: now,
      stateHistory: []
    }
    mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: 'Pi ready' } }
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-pi-prompt')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'omp\r')
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(transport.sendInput).toHaveBeenCalledWith('omp\r')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Pi ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'pi',
      terminalTitle: 'Pi ready'
    })
  })

  it('does not infer shell ownership from prompts typed in a title-only Pi session', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: 'Pi ready' } }
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-pi-title-only')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'omp\r')
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(transport.sendInput).toHaveBeenCalledWith('omp\r')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Pi ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'pi',
      terminalTitle: 'Pi ready'
    })
  })

  it('lets a new typed omp command override a stale retained done status', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const now = Date.now()
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: '',
      agentType: 'pi',
      paneKey,
      terminalTitle: 'Pi ready',
      updatedAt: now,
      stateStartedAt: now,
      stateHistory: []
    }
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-stale-done')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'omp\r')
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'OMP ready')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('tracks cursor edits when inferring a typed omp command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-cursor-edit')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'op\x1b[Dm\r')
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(transport.sendInput).toHaveBeenCalledWith('op\x1b[Dm\r')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('tracks delete-key cursor edits when inferring a typed omp command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-delete-edit')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'ommp\x1b[D\x1b[D\x1b[3~\r')
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('skips manual agent inference for large paste chunks', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-large-paste')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, `${'x'.repeat(4097)}omp\r`)
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'pi',
      terminalTitle: 'Pi ready'
    })
  })

  it('resumes manual agent inference when large paste input is cancelled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-cancelled-large-paste')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'x'.repeat(4097))
    sendTerminalInputThroughPane(pane, '\x03')
    sendTerminalInputThroughPane(pane, 'omp\r')
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('preserves typed shell ownership through same-chunk command-finished side effects', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const pane = createPane(1)
    const transport = createMockTransport('remote:env-1@@pty-command-finished')
    transport.connect.mockImplementation(
      async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
        dataCallbackRef.current = callbacks?.onData ?? null
        return 'remote:env-1@@pty-command-finished'
      }
    )
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    sendTerminalInputThroughPane(pane, 'omp\r')
    await flushAsyncTicks()
    const onTitleChange = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    const dataCallback = dataCallbackRef.current
    if (!dataCallback || !onTitleChange || !onAgentStatus) {
      throw new Error('missing remote PTY callbacks')
    }
    dataCallback('\x1b]133;D;0\x07')
    onTitleChange('Pi ready', 'Pi ready')
    onAgentStatus({
      state: 'done',
      prompt: '',
      agentType: 'pi'
    })

    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('queues visible bulk output off the synchronous xterm write path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    vi.useFakeTimers()
    capturedDataCallback.current?.('x'.repeat(16 * 1024))

    expect(pane.terminal.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(pane.terminal.write).toHaveBeenCalledWith('x'.repeat(16 * 1024), expect.any(Function))
  })

  it('keeps ANSI redraws after terminal input on the immediate xterm write path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    const onDataMock = pane.terminal.onData as unknown as {
      mock: { calls: [[(data: string) => void] | []] }
    }
    const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
    expect(terminalInputHandler).toBeTypeOf('function')
    terminalInputHandler?.('a')

    const redraw = `\x1b[2J\x1b[H${'codex composer redraw '.repeat(200)}`
    capturedDataCallback.current?.(redraw)

    expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
  })

  it('keeps large ANSI redraws after terminal input on the immediate xterm write path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    const onDataMock = pane.terminal.onData as unknown as {
      mock: { calls: [[(data: string) => void] | []] }
    }
    const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
    expect(terminalInputHandler).toBeTypeOf('function')
    terminalInputHandler?.('a')

    const redraw = `\x1b[2J\x1b[H${'codex large composer redraw '.repeat(1_200)}`
    expect(redraw.length).toBeGreaterThan(16 * 1024)
    expect(redraw.length).toBeLessThan(128 * 1024)
    capturedDataCallback.current?.(redraw)

    expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
  })

  it('does not let OpenTUI-style small ANSI redraw bursts monopolize foreground writes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('pty-1')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-1'
    })
    transportFactoryQueue.push(transport)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    vi.useFakeTimers()

    const frames = Array.from({ length: 270 }, (_, index) =>
      [
        '\x1b[?2026h',
        '\x1b[?25l',
        `\x1b[2;3H\x1b[38;2;255;138;0m${index % 2 === 0 ? '#' : '*'}${'*'.repeat(7)}\x1b[0m`,
        `\x1b[2;12H\x1b[38;2;255;138;0mOpenTUI synthetic active TUI redraw ${index}\x1b[0m`,
        `\x1b[4;6H\x1b[38;2;231;237;247m${'#'.repeat(36)} ${'opentui'.repeat(48)}\x1b[0m`
      ].join('')
    )
    expect(frames.every((frame) => frame.length <= 2048 && frame.includes('\x1b['))).toBe(true)
    expect(frames.join('').length).toBeGreaterThan(128 * 1024)

    for (const frame of frames) {
      capturedDataCallback.current?.(frame)
    }

    expect(pane.terminal.write.mock.calls.length).toBeLessThan(frames.length)
    vi.advanceTimersByTime(0)
    expect(pane.terminal.write.mock.calls.length).toBeGreaterThan(0)
  })

  it('keeps the surviving split pane mounted when an intentional pane-close PTY exit arrives', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')

    onPtyExit?.('pty-pane-2')

    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
    expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(2, null)
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-pane-2')
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('defers all exit-side state mutation while worktree shutdown verification is pending', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { settleDeferredPtyShutdownExits } = await import('./pty-shutdown-exit-deferral')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    let pending = true
    const deps = createDeps({
      isPtyShutdownPending: vi.fn(() => pending),
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined

    onPtyExit?.('pty-pane-2')

    expect(deps.consumeSuppressedPtyExit).not.toHaveBeenCalled()
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()

    pending = false
    settleDeferredPtyShutdownExits(['pty-pane-2'], 'committed')
    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
    expect(deps.clearRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 2)
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
  })

  it('keeps renderer state intact for an exit deferred through rollback', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { settleDeferredPtyShutdownExits } = await import('./pty-shutdown-exit-deferral')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    let pending = true
    const deps = createDeps({
      isPtyShutdownPending: vi.fn(() => pending),
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('pty-pane-2')

    pending = false
    settleDeferredPtyShutdownExits(['pty-pane-2'], 'rolled-back')

    expect(deps.consumeSuppressedPtyExit).not.toHaveBeenCalled()
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('preserves wake identifiers when exit arrives after a committed shutdown', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markCommittedPtyShutdowns } = await import('./pty-shutdown-exit-deferral')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      isPtyShutdownPending: vi.fn(() => false),
      consumeSuppressedPtyExit: vi.fn(() => true)
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined

    markCommittedPtyShutdowns(['pty-pane-2'])
    onPtyExit?.('pty-pane-2')

    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('disarms input modes and resumes a hibernated agent session on visibility reveal', async () => {
    // Regression: hibernation suppresses its kill's PTY exit while hidden; before the wake fix onExit permanently latched handledExitPtyId, leaving a frozen inert ghost pane on reveal.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    // Hibernation only targets hidden panes, so the exit lands while not visible and the wake must wait for the reveal.
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const pane = createPane(2)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-1' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    mockStoreState.suppressedPtyExitIds['tab-pty'] = true

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      noteVisibilityResume: () => void
      dispose: () => void
    }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    // The deferred connect attached this transport to the persisted tab PTY, so the kill's exit must carry that id for the wake guard's same-pty check.
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
    const connectCallsBeforeExit = transport.connect.mock.calls.length
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()

    // The frozen frame's input-eating modes are disarmed at hibernation-exit (mouse tracking / bracketed paste would otherwise swallow clicks).
    const writesAfterExit = pane.terminal.write.mock.calls.flat().join('')
    expect(writesAfterExit).toContain('\x1b[?1003l')
    expect(writesAfterExit).toContain('\x1b[?2004l')
    // A hidden pane must not respawn on exit — the wake waits for the reveal.
    expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)

    binding.noteVisibilityResume()
    await flushAsyncTicks()

    expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
    const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
      | { command?: string }
      | undefined
    expect(resumeConnectOptions?.command).toContain('--resume')
    expect(resumeConnectOptions?.command).toContain('sess-hibernated-1')

    // The wake is one-shot: a second reveal must not spawn again.
    const connectCallsAfterWake = transport.connect.mock.calls.length
    binding.noteVisibilityResume()
    await flushAsyncTicks()
    expect(transport.connect.mock.calls.length).toBe(connectCallsAfterWake)
  })

  it('resumes a hibernated agent from a navigation-free wake without a visibility reveal', async () => {
    // Mobile wake fanout drives wakeHibernatedAgentIfArmed on a still-hidden pane (no isVisible flip): the armed --resume must fire exactly once even if delivered twice (INV-1).
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const pane = createPane(2)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-bg' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    mockStoreState.suppressedPtyExitIds['tab-pty'] = true

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      wakeHibernatedAgentIfArmed: (claimedProviderSessions?: Set<string>) => string | null
      dispose: () => void
    }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
    const connectCallsBeforeExit = transport.connect.mock.calls.length
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()
    // Still hidden: no reveal happened, so nothing respawned on exit.
    expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)

    // The wake reports the claim it consumed so the dispatcher's generic resume never launches the same provider session into a second tab.
    const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-bg'
    expect(binding.wakeHibernatedAgentIfArmed(new Set([claimKey]))).toBeNull()
    expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)
    const claimedProviderSessions = new Set<string>()
    expect(binding.wakeHibernatedAgentIfArmed(claimedProviderSessions)).toBe(claimKey)
    expect(claimedProviderSessions).toEqual(new Set([claimKey]))
    await flushAsyncTicks()

    expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
    const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
      | { command?: string }
      | undefined
    expect(resumeConnectOptions?.command).toContain('--resume')
    expect(resumeConnectOptions?.command).toContain('sess-hibernated-bg')

    // A second navigation-free wake must not spawn again (one-pane/one-PTY).
    const connectCallsAfterWake = transport.connect.mock.calls.length
    binding.wakeHibernatedAgentIfArmed()
    await flushAsyncTicks()
    expect(transport.connect.mock.calls.length).toBe(connectCallsAfterWake)
  })

  it('latches a navigation-free wake that lands before the hibernation kill arms the pane', async () => {
    // Race (#7906): the edge-triggered wake can land after the sleeping record but before the kill sets hibernatedWakePtyId; without a latch it'd be dropped, leaving a frozen terminal.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const pane = createPane(2)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-race' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    mockStoreState.suppressedPtyExitIds['tab-pty'] = true

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      wakeHibernatedAgentIfArmed: (claimedProviderSessions?: Set<string>) => string | null
      dispose: () => void
    }
    await flushAsyncTicks()
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')

    // Wake arrives mid-kill: nothing is armed yet, but the pane must claim the session (suppressing the generic resume) and latch the request.
    const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-race'
    expect(binding.wakeHibernatedAgentIfArmed(new Set([claimKey]))).toBeNull()
    const claimedProviderSessions = new Set<string>()
    expect(binding.wakeHibernatedAgentIfArmed(claimedProviderSessions)).toBe(claimKey)
    expect(claimedProviderSessions).toEqual(new Set([claimKey]))
    const connectCallsBeforeExit = transport.connect.mock.calls.length

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()

    // Arming consumed the latched wake — the --resume spawned with no reveal and no second wake event.
    expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
    const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
      | { command?: string }
      | undefined
    expect(resumeConnectOptions?.command).toContain('--resume')
    expect(resumeConnectOptions?.command).toContain('sess-hibernated-race')
  })

  it('keeps an in-place provider claim until the replacement PTY spawn settles', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-inflight' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    const binding = connectPanePty(
      createPane(2) as never,
      createManager(1) as never,
      deps as never
    ) as unknown as {
      wakeHibernatedAgentIfArmed: () => string | null
    }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()
    const deferredSpawn = createDeferred<unknown>()
    transport.connect.mockImplementationOnce(() => deferredSpawn.promise)

    const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-inflight'
    expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
    const connectCallsAfterFirstWake = transport.connect.mock.calls.length
    expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
    expect(transport.connect.mock.calls.length).toBe(connectCallsAfterFirstWake)

    deferredSpawn.resolve('pty-resumed')
    await flushAsyncTicks()
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
  })

  it('re-arms the exact hibernation target after a replacement spawn fails', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-retry' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    const binding = connectPanePty(
      createPane(2) as never,
      createManager(1) as never,
      createDeps({
        consumeSuppressedPtyExit: vi.fn(() => true),
        isVisibleRef: { current: false }
      }) as never
    ) as unknown as { wakeHibernatedAgentIfArmed: () => string | null }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()
    transport.connect.mockRejectedValueOnce(new Error('transient spawn failure'))

    const claimKey = 'wt-1\0claude\0session_id\0sess-hibernated-retry'
    expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
    await flushAsyncTicks(20)
    const connectCallsAfterFailure = transport.connect.mock.calls.length

    expect(binding.wakeHibernatedAgentIfArmed()).toBe(claimKey)
    expect(transport.connect.mock.calls.length).toBe(connectCallsAfterFailure + 1)
  })

  it('does not latch a stale sleeping record beside an unsuppressed live PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-stale' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    const binding = connectPanePty(
      createPane(2) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    ) as unknown as {
      wakeHibernatedAgentIfArmed: () => string | null
    }
    await flushAsyncTicks()

    expect(binding.wakeHibernatedAgentIfArmed()).toBeNull()
  })

  it('auto-resumes a hibernated pane when its kill lands after the pane is already revealed', async () => {
    // Race: reveal's noteVisibilityResume runs before onExit arms the wake, so the arm-time foreground check must resume the pane instead of stranding a disarmed-but-dead frame.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: true }
    })
    const pane = createPane(2)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-2' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      noteVisibilityResume: () => void
      dispose: () => void
    }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    // The deferred connect attached this transport to the persisted tab PTY, so the kill's exit must carry that id for the wake guard's same-pty check.
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
    const connectCallsBeforeExit = transport.connect.mock.calls.length
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()

    // No second reveal was needed: the foreground pane resumed its recorded session directly from the arm-time wake.
    expect(transport.connect.mock.calls.length).toBeGreaterThan(connectCallsBeforeExit)
    const resumeConnectOptions = transport.connect.mock.calls.at(-1)?.[0] as
      | { command?: string }
      | undefined
    expect(resumeConnectOptions?.command).toContain('--resume')
    expect(resumeConnectOptions?.command).toContain('sess-hibernated-2')

    // Still one-shot: a later reveal must not spawn again.
    const connectCallsAfterWake = transport.connect.mock.calls.length
    binding.noteVisibilityResume()
    await flushAsyncTicks()
    expect(transport.connect.mock.calls.length).toBe(connectCallsAfterWake)
  })

  it('invalidates the hibernation wake when another flow rebinds the pane before reveal', async () => {
    // Why: intentional restarts share hibernation's exit suppression; a rebind while hidden owns the pane, so the armed wake must be discarded on reveal — permanently, not revived by a later death.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps({
      consumeSuppressedPtyExit: vi.fn(() => true),
      isVisibleRef: { current: false }
    })
    const pane = createPane(2)
    const paneKey = `tab-1:${leafIdForPane(2)}`
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated-3' },
      prompt: 'test prompt',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      noteVisibilityResume: () => void
      dispose: () => void
    }
    await flushAsyncTicks()

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
    const connectCallsBeforeExit = transport.connect.mock.calls.length
    onPtyExit?.('tab-pty')
    await flushAsyncTicks()

    // Another flow rebinds the pane to a fresh PTY while it is still hidden.
    transport.getPtyId.mockReturnValue('pty-restarted')
    binding.noteVisibilityResume()
    await flushAsyncTicks()
    // The rebound pane keeps its own session: no wake-driven resume spawn.
    expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)

    // The rebound PTY later dies without a new sleeping record; the stale wake must not fire on the next reveal.
    transport.getPtyId.mockReturnValue(null)
    binding.noteVisibilityResume()
    await flushAsyncTicks()
    expect(transport.connect.mock.calls.length).toBe(connectCallsBeforeExit)
  })

  it('records hibernation activity from the core user-input signal, not synthetic onData replies', async () => {
    // Regression: xterm auto-replies share the onData stream with typing; recording them as input made the planner see "input after done" and never hibernate.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()
    const pane = createPane(2)
    let userInputListener: (() => void) | null = null
    const userInputDispose = vi.fn()
    ;(pane.terminal as unknown as { _core: unknown })._core = {
      coreService: {
        onUserInput: vi.fn((listener: () => void) => {
          userInputListener = listener
          return { dispose: userInputDispose }
        })
      }
    }

    const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
      dispose: () => void
    }
    await flushAsyncTicks()
    expect(userInputListener).toBeTypeOf('function')
    ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()

    // A focus-out report forwarded to the PTY must not count as activity.
    sendTerminalInputThroughPane(pane, '\x1b[O')
    expect(mockStoreState.recordTerminalInput).not.toHaveBeenCalled()
    // The reply still reaches the shell; only the activity recording is gated.
    expect(transport.sendInput).toHaveBeenCalledWith('\x1b[O')

    // Real user input fires the core signal and records activity.
    ;(userInputListener as unknown as () => void)()
    expect(mockStoreState.recordTerminalInput).toHaveBeenCalledTimes(1)

    binding.dispose()
    expect(userInputDispose).toHaveBeenCalled()
  })

  it('falls back to onData hibernation recording when the core user-input signal is unavailable', async () => {
    // If an xterm upgrade removes the internal signal, activity recording must degrade to the historical onData behavior — never to no tracking at all.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()
    const pane = createPane(2)

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()

    sendTerminalInputThroughPane(pane, 'x')
    expect(mockStoreState.recordTerminalInput).toHaveBeenCalledTimes(1)
  })

  it('keeps a fresh split pane mounted when its newborn PTY exits before output or input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(2, 2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) },
      clearExitedPanePtyLayoutBinding: vi.fn(() => {
        mockStoreState = {
          ...mockStoreState,
          terminalLayoutsByTabId: {
            ...mockStoreState.terminalLayoutsByTabId,
            'tab-1': {
              root: {
                type: 'split',
                direction: 'horizontal',
                first: { type: 'leaf', leafId: LEAF_1 },
                second: { type: 'leaf', leafId: LEAF_2 },
                ratio: 0.5
              },
              activeLeafId: LEAF_1,
              expandedLeafId: null,
              ptyIdsByLeafId: { [LEAF_1]: 'pty-pane-1' }
            }
          }
        }
      })
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')

    onPtyExit?.('pty-pane-2')

    expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-pane-2')
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-pane-2')
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
    expect(manager.setActivePane).toHaveBeenCalledWith(1, { focus: true })
  })

  it('closes a hidden split pane whose PTY exits before output instead of keeping a ghost', async () => {
    // Why (regression, ghost blank pane): a hidden pane's bytes are withheld by the hidden-delivery gate, so "no output" proves nothing — keeping it strands a blank ghost on reveal.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(2, 2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      isVisibleRef: { current: false },
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')

    onPtyExit?.('pty-pane-2')

    expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-pane-2')
    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).toHaveBeenCalledWith(2)
  })

  it('keeps a worktree sole terminal mounted when its freshly-spawned PTY exits before input (direnv failure)', async () => {
    // Why (regression): a failing .envrc direnv makes the sole terminal's shell exit immediately; routing to onPtyExitRef would close the tab and bounce the user to Landing, so keep it mounted.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(createPane(1) as never, manager as never, deps as never)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    expect(onPtyExit).toBeTypeOf('function')

    // A genuine fresh spawn (onPtySpawn fires only for non-reattach spawns) the user never typed into.
    onPtySpawn?.('tab-pty')
    onPtyExit?.('tab-pty')

    expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('tears down the sole terminal when a freshly-spawned PTY exits after the user typed input', async () => {
    // Why: an explicit `exit` (or any typed input) is a deliberate close, not a failed-startup shell, so the worktree should deactivate as before.
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(1)
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    expect(onPtyExit).toBeTypeOf('function')

    onPtySpawn?.('tab-pty')
    sendTerminalInputThroughPane(pane, 'exit\r')
    onPtyExit?.('tab-pty')

    expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty')
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('tears down the sole terminal when a reattached (not freshly spawned) PTY exits', async () => {
    // Why: reattach/coldRestore skip onPtySpawn, so a now-dead previously-live session must still route through onPtyExitRef; the keep-mounted guard is only for brand-new shells.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(createPane(1) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')

    // No onPtySpawn call: simulates a reattach to a persisted session.
    onPtyExit?.('tab-pty')

    expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty')
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('rebinds a provider replacement without granting fresh-spawn exit protection', async () => {
    const { connectPanePty } = await import('./pty-connection')
    let transportPtyId = 'terminal-old'
    const transport = createMockTransport(transportPtyId)
    transport.getPtyId = vi.fn(() => transportPtyId)
    transportFactoryQueue.push(transport)
    const manager = createManager(1)
    const deps = createDeps()
    const pane = createPane(1)

    connectPanePty(pane as never, manager as never, deps as never)
    const onPtyRebind = createdTransportOptions[0]?.onPtyRebind as
      | ((ptyId: string, replacedPtyId: string) => void)
      | undefined
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyRebind).toBeTypeOf('function')
    expect(onPtyExit).toBeTypeOf('function')

    transportPtyId = 'terminal-reconnected'
    onPtyRebind?.('terminal-reconnected', 'terminal-old')

    expect((transport.getPtyId as unknown as () => string | null)()).toBe('terminal-reconnected')
    expect(pane.container.dataset.ptyId).toBe('terminal-reconnected')
    onPtyExit?.('terminal-reconnected')

    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'terminal-reconnected')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith(
      'tab-1',
      'terminal-reconnected',
      'terminal-old'
    )
    expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('terminal-reconnected')
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('closes a split pane when an established PTY exits after output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-pane-2')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-pane-2'
    })
    transportFactoryQueue.push(transport)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
    })

    connectPanePty(createPane(2) as never, manager as never, deps as never)
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    expect(capturedDataCallback.current).toBeTypeOf('function')

    capturedDataCallback.current?.('shell prompt')
    onPtyExit?.('pty-pane-2')

    expect(manager.closePane).toHaveBeenCalledWith(2)
  })

  it('closes a split pane when an established PTY exits after terminal input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const pane = createPane(2)
    const transport = createMockTransport('pty-pane-2')
    transportFactoryQueue.push(transport)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    const onDataMock = pane.terminal.onData as unknown as {
      mock: { calls: [[(data: string) => void] | []] }
    }
    const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(terminalInputHandler).toBeTypeOf('function')
    expect(onPtyExit).toBeTypeOf('function')

    terminalInputHandler?.('exit\r')
    onPtyExit?.('pty-pane-2')

    expect(manager.closePane).toHaveBeenCalledWith(2)
  })

  it('does not send startup command via sendInput for local connections', async () => {
    // Why: the local PTY provider already writes the command via writeStartupCommandWhenShellReady; re-sending from the renderer would double it in the terminal.
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-local-1'
    })
    transportFactoryQueue.push(transport)

    // Local connection: no connectionId
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ startup: { command: "claude 'say test'" } })

    connectPanePty(pane as never, manager as never, deps as never)
    expect(capturedDataCallback.current).not.toBeNull()

    // Simulate PTY output (shell prompt arriving)
    capturedDataCallback.current?.('(base) user@host $ ')

    // Even after the debounce, the renderer must not inject the command (main already wrote it via writeStartupCommandWhenShellReady).
    expect(transport.sendInput).not.toHaveBeenCalledWith(
      expect.stringContaining("claude 'say test'")
    )
  })

  it('seeds a working status for Command Code startup prompts after spawn', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const sshPtyId = toAppSshPtyId('ssh-a', 'pty-command-code')
    const transport = createMockTransport(sshPtyId)
    transport.getConnectionId.mockReturnValue('ssh-a')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'ssh-a' }],
      sshConnectionStates: new Map([['ssh-a', { status: 'connected' }]])
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: "command-code --trust 'Fix the status'",
        initialAgentStatus: { agent: 'command-code', prompt: 'Fix the status' }
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    onPtySpawn?.(sshPtyId)

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'Fix the status',
        agentType: 'command-code'
      },
      undefined,
      undefined,
      { connectionId: 'ssh-a' }
    )
  })

  it('seeds a working status from Command Code thinking output without a startup prompt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const sshPtyId = toAppSshPtyId('ssh-a', 'pty-command-code')
    const transport = createMockTransport(sshPtyId)
    transport.getConnectionId.mockReturnValue('ssh-a')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return sshPtyId
    })
    transportFactoryQueue.push(transport)
    mockStoreState.repos = [{ id: 'repo1', connectionId: 'ssh-a' }]
    mockStoreState.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
    capturedDataCallback.current?.('❯ Fix the spinner\r\n\x1b[35m✻ Thinking...\x1b[0m')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'Fix the spinner',
        agentType: 'command-code'
      },
      undefined,
      undefined,
      { connectionId: 'ssh-a' }
    )
  })

  it('ignores delayed Command Code output after the leaf rebinds to another SSH host', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const oldPtyId = toAppSshPtyId('ssh-a', 'pty-command-code')
    const newPtyId = toAppSshPtyId('ssh-b', 'pty-command-code')
    const transport = createMockTransport(oldPtyId)
    transport.getConnectionId.mockReturnValue('ssh-a')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return oldPtyId
    })
    transportFactoryQueue.push(transport)
    mockStoreState.repos = [{ id: 'repo1', connectionId: 'ssh-a' }]
    mockStoreState.sshConnectionStates = new Map([['ssh-a', { status: 'connected' }]])

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ startup: { command: 'command-code --trust' } }) as never
    )
    await flushAsyncTicks()
    mockStoreState.setAgentStatus.mockClear()
    mockStoreState.ptyIdsByTabId = { 'tab-1': [oldPtyId, newPtyId] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: newPtyId }

    capturedDataCallback.current?.('❯ stale prompt\r\n\x1b[35m✻ Thinking...\x1b[0m')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
  })

  it('marks a Command Code no-tool turn done after the idle prompt settles', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-command-code')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(pane as never, manager as never, deps as never)
    vi.runOnlyPendingTimers()
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('❯ say hi\r\n✻ Thinking...')
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      prompt: 'say hi',
      agentType: 'command-code'
    })

    capturedDataCallback.current?.(
      '\r\n✻ Thought for 1 second\r\n:: Hi! How can I help you today?\r\n❯ Ask your question...'
    )
    vi.advanceTimersByTime(1499)
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      prompt: 'say hi',
      agentType: 'command-code'
    })

    vi.advanceTimersByTime(1)
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'done',
      prompt: 'say hi',
      agentType: 'command-code'
    })
  })

  it('keeps Command Code working when an active repaint follows the idle prompt before settle', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-command-code')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(pane as never, manager as never, deps as never)
    vi.runOnlyPendingTimers()
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('❯ Run a slow command\r\n✻ Thinking...')
    capturedDataCallback.current?.('\r\n❯ Ask your question...')
    vi.advanceTimersByTime(1000)
    capturedDataCallback.current?.('\r\n✧ Investigating... esc to interrupt')
    vi.advanceTimersByTime(500)

    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
      state: 'working',
      prompt: 'Run a slow command',
      agentType: 'command-code'
    })
  })

  it('does not downgrade a completed Command Code turn back to working from stale TUI output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-command-code')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      stateHistory: []
    }

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
    capturedDataCallback.current?.('❯ Fix the spinner\r\n\x1b[35m✻ Threading...\x1b[0m')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    expect((mockStoreState.agentStatusByPaneKey[paneKey] as { state?: unknown })?.state).toBe(
      'done'
    )
  })

  it('starts a new Command Code turn after done when TUI output carries a different prompt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-command-code')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-command-code'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'command-code --trust'
      }
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      stateHistory: []
    }

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
    capturedDataCallback.current?.('❯ Fix the green done state\r\n\x1b[35m✻ Threading...\x1b[0m')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      paneKey,
      {
        state: 'working',
        prompt: 'Fix the green done state',
        agentType: 'command-code'
      },
      undefined,
      undefined,
      { connectionId: null }
    )
  })

  it('delivers terminal-paste startup commands through xterm before submitting', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-local-paste'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const pane = createPane(1)
      pane.terminal.modes.bracketedPasteMode = true
      pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const command = 'cd packages\nbun run build\ncd ..'
      const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(createdTransportOptions[0]?.command).toBeUndefined()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@host $ ')
      await drainPendingTimeouts(pendingTimeouts)
      await flushAsyncTicks()

      expect(pane.terminal.paste).toHaveBeenCalledWith(command)
      expect(transport.sendInput).toHaveBeenCalledWith('\r')
      expect(transport.sendInput).not.toHaveBeenCalledWith(`${command}\r`)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('chunks large terminal-paste startup commands through the PTY before submitting', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-local-paste'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const pane = createPane(1)
      pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const command = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`
      const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(createdTransportOptions[0]?.command).toBeUndefined()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@host $ ')
      await drainPendingTimeouts(pendingTimeouts)
      await flushAsyncTicks()

      const writtenInput = transport.sendInput.mock.calls.map((call) => call[0])
      expect(pane.terminal.paste).not.toHaveBeenCalled()
      expect(writtenInput.at(-1)).toBe('\r')
      expect(writtenInput.slice(0, -1).join('')).toBe(command)
      expect(writtenInput.slice(0, -1).length).toBeGreaterThan(1)
      expect(transport.sendInput).not.toHaveBeenCalledWith(`${command}\r`)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('does not submit a terminal-paste startup command after the PTY changes mid-paste', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-id')
      let livePtyId = 'pty-local-paste'
      transport.getPtyId.mockImplementation(() => livePtyId)
      transport.sendInput.mockImplementation((data: string) => {
        if (data !== '\r') {
          livePtyId = 'pty-replaced'
        }
        return true
      })
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-local-paste'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const pane = createPane(1)
      pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const command = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`
      const deps = createDeps({ startup: { command, delivery: 'terminal-paste' } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@host $ ')
      await drainPendingTimeouts(pendingTimeouts)
      await flushAsyncTicks()

      expect(pane.terminal.paste).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalledWith('\r')
      expect(transport.sendInput.mock.calls.map((call) => call[0]).join('')).not.toBe(command)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('infers interrupts only from the focused terminal key target', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop this task',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const unrelatedTarget = createKeyboardEventTarget()
    ;(
      globalThis.window as unknown as { addEventListener?: ReturnType<typeof vi.fn> }
    ).addEventListener = vi.fn()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    unrelatedTarget.dispatch({
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false
    } as KeyboardEvent)
    vi.advanceTimersByTime(500)
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(globalThis.window.addEventListener).not.toHaveBeenCalled()

    terminalTarget.dispatch({
      key: 'c',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false
    } as KeyboardEvent)
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop this task',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
  })

  it('clears stale working pane title after inferred interrupt applies', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { resolveWorktreeStatus } = await import('@/lib/worktree-status')
    vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(true)
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop visible spinner',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps({
      setRuntimePaneTitle: vi.fn((tabId: string, paneId: number, title: string) => {
        mockStoreState.runtimePaneTitlesByTabId = {
          ...mockStoreState.runtimePaneTitlesByTabId,
          [tabId]: {
            ...mockStoreState.runtimePaneTitlesByTabId[tabId],
            [paneId]: title
          }
        }
      })
    })

    connectPanePty(pane as never, manager as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Terminal')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Terminal')
    expect(
      resolveWorktreeStatus({
        tabs: [{ id: 'tab-1', title: 'Codex working' }],
        browserTabs: [],
        ptyIdsByTabId: { 'tab-1': ['tab-pty'] },
        runtimePaneTitlesByTabId: mockStoreState.runtimePaneTitlesByTabId,
        hasPermission: false,
        hasLiveWorking: false,
        hasLiveDone: true,
        hasRetainedDone: false
      })
    ).toBe('done')
  })

  it('clears unchanged title-only working indicators after acknowledged interrupt input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps({
      setRuntimePaneTitle: vi.fn((tabId: string, paneId: number, title: string) => {
        mockStoreState.runtimePaneTitlesByTabId = {
          ...mockStoreState.runtimePaneTitlesByTabId,
          [tabId]: {
            ...mockStoreState.runtimePaneTitlesByTabId[tabId],
            [paneId]: title
          }
        }
      })
    })

    connectPanePty(pane as never, manager as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Terminal')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Terminal')
  })

  it('does not clear title-only working indicators when interrupt writes are unacknowledged', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    delete transport.sendInputAccepted
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const deps = createDeps()

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(transport.sendInput).toHaveBeenCalledWith('\x03')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(deps.setRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.updateTabTitle).not.toHaveBeenCalled()
  })

  it('infers exact Ctrl+C terminal input when keydown capture misses the press', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop from real terminal byte',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop from real terminal byte',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
  })

  it('marks bracketed paste as stale after acknowledged Ctrl+C input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { pasteTerminalText } = await import('./terminal-bracketed-paste')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.modes.bracketedPasteMode = true
    const observedIgnoreValues: (boolean | undefined)[] = []
    pane.terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(pane.terminal.options.ignoreBracketedPasteMode)
    })
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    pasteTerminalText(pane.terminal as never, 'a69ce28e1d092e0c8825cd1a109ac36409962bc1')

    expect(observedIgnoreValues).toEqual([true])
    expect(pane.terminal.options.ignoreBracketedPasteMode).toBe(false)
  })

  it('infers captured Ctrl+C even when xterm emits an enhanced keyboard sequence', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop enhanced keyboard input',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x1b[99;5u')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(transport.sendInputAccepted).toHaveBeenCalledWith('\x1b[99;5u')
    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop enhanced keyboard input',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
  })

  it('infers interrupt for an explicit working status even if the title is already non-agent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop after process exit',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x1b[99;5u')
    await flushAsyncTicks()
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Terminal 1'
      }
    }
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop after process exit',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it('keeps inferred interrupted status after the pane settles on a non-agent title', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop and leave shell',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    vi.mocked(window.api.agentStatus.inferInterrupt).mockImplementation(async () => {
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'stop and leave shell',
        interrupted: true,
        updatedAt: 1_100,
        stateStartedAt: 1_100,
        agentType: 'codex',
        paneKey,
        terminalTitle: 'Terminal 1'
      }
      return true
    })
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const deps = createDeps({
      setRuntimePaneTitle: vi.fn((tabId: string, paneId: number, title: string) => {
        mockStoreState.runtimePaneTitlesByTabId = {
          ...mockStoreState.runtimePaneTitlesByTabId,
          [tabId]: {
            ...mockStoreState.runtimePaneTitlesByTabId[tabId],
            [paneId]: title
          }
        }
      })
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x1b[99;5u')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()
    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalled()
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()

    vi.advanceTimersByTime(750)
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it('does not infer exact interrupt input when the transport cannot acknowledge writes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    delete transport.sendInputAccepted
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'ssh style write',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()

    expect(transport.sendInput).toHaveBeenCalledWith('\x03')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('removes agent status and pane title on PTY exit after inferred interrupt', async () => {
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(true)
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.runtimePaneTitlesByTabId = {
      'tab-1': {
        1: 'Codex working'
      }
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'stop then exit',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex working',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const deps = createDeps()

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)
    await flushAsyncTicks()
    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    if (!onPtyExit) {
      throw new Error('expected onPtyExit callback to be registered')
    }

    onPtyExit('tab-pty')

    expect(deps.clearRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'tab-pty')
    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, null)
    expect(mockStoreState.removeAgentStatus).toHaveBeenCalledWith(paneKey)
  })

  it('ignores repeated and modified terminal interrupt keydowns', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'keep running',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    for (const event of [
      {
        key: 'Escape',
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: true
      },
      {
        key: 'Escape',
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: false,
        repeat: false
      },
      {
        key: 'c',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        repeat: false
      }
    ]) {
      terminalTarget.dispatch(event as KeyboardEvent)
    }
    vi.advanceTimersByTime(500)

    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('does not infer Ctrl+C when terminal selection turns the chord into copy', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'copy selection',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      paneKey,
      terminalTitle: 'Codex',
      stateHistory: []
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown; hasSelection: ReturnType<typeof vi.fn> }).element =
      terminalTarget.target
    ;(pane.terminal as { hasSelection: ReturnType<typeof vi.fn> }).hasSelection.mockReturnValue(
      true
    )

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    vi.advanceTimersByTime(500)

    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('removes the terminal key listener on dispose before a remount adds another', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const firstTransport = createMockTransport()
    const secondTransport = createMockTransport()
    transportFactoryQueue.push(firstTransport, secondTransport)
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target

    const firstConnection = connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps() as never
    )
    expect(terminalTarget.handlers.size).toBe(1)

    firstConnection.dispose()
    expect(terminalTarget.handlers.size).toBe(0)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    expect(terminalTarget.handlers.size).toBe(1)
    expect(terminalTarget.target.addEventListener).toHaveBeenCalledTimes(2)
    expect(terminalTarget.target.removeEventListener).toHaveBeenCalledTimes(1)
  })

  it('clears the mobile-fit pane binding when the pane connection is disposed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getFitOverrideForPane, setFitOverride } =
      await import('@/lib/pane-manager/mobile-fit-overrides')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)

    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    onPtySpawn?.('pty-fit')
    setFitOverride('pty-fit', 'mobile-fit', 49, 20)

    expect(getFitOverrideForPane(1, 'tab-1')).toEqual({ mode: 'mobile-fit', cols: 49, rows: 20 })
    expect(pane.container.dataset.ptyId).toBe('pty-fit')

    binding.dispose()

    expect(getFitOverrideForPane(1, 'tab-1')).toBeNull()
    expect(pane.container.dataset.ptyId).toBeUndefined()
  })

  it('refits immediately when binding to a PTY with an active mobile-fit override', async () => {
    const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    Object.defineProperty(pane.container, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          width: 800,
          height: 400,
          top: 0,
          left: 0,
          right: 800,
          bottom: 400
        }) as DOMRect
    })
    ;(
      pane.fitAddon as unknown as { proposeDimensions: () => { cols: number; rows: number } }
    ).proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 }))
    pane.terminal.resize.mockImplementation((cols: number, rows: number) => {
      pane.terminal.cols = cols
      pane.terminal.rows = rows
    })
    setFitOverride('pty-fit', 'mobile-fit', 49, 20)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    onPtySpawn?.('pty-fit')

    expect(pane.terminal.resize).toHaveBeenCalledWith(49, 20)
    expect(pane.terminal.cols).toBe(49)
    expect(pane.terminal.rows).toBe(20)
  })

  it('continues post-spawn size reconcile after a transient mobile presence lock', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const runNextFrame = (): void => {
      const callback = frameCallbacks.shift()
      if (!callback) {
        throw new Error('expected a queued animation frame')
      }
      callback(0)
    }

    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    const ptyId = 'pty-post-spawn-transient-lock'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] }
      }
      const pane = createPane(1)
      pane.terminal.cols = 80
      pane.terminal.rows = 24

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      runNextFrame()
      await flushAsyncTicks()

      pane.terminal.cols = 120
      pane.terminal.rows = 40
      runNextFrame()
      expect(transport.resize).not.toHaveBeenCalled()

      setDriverForPty(ptyId, { kind: 'idle' })
      runNextFrame()

      expect(transport.resize).toHaveBeenCalledWith(120, 40)
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('waits for setup-split geometry before spawning the initial startup command', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const runNextFrame = (): void => {
      const callback = frameCallbacks.shift()
      if (!callback) {
        throw new Error('expected a queued animation frame')
      }
      callback(0)
    }

    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }

    const pane = createPane(1)
    const siblingPane = createPane(2)
    let panes = [pane]
    let proposedGrid = { cols: 240, rows: 50 }
    let splitMounted = false
    const root = createMeasuredElement({ rect: () => createRect(1200, 800) })
    const split = createMeasuredElement({
      className: () => (splitMounted ? 'pane-split is-vertical' : ''),
      rect: () => createRect(1200, 800)
    })
    const mainContainer = createMeasuredElement({
      parentElement: () => (splitMounted ? split : root),
      rect: () => (splitMounted ? createRect(600, 800) : createRect(1200, 800))
    })
    const setupContainer = createMeasuredElement({
      parentElement: () => (splitMounted ? split : null),
      rect: () => createRect(599, 800, 601, 0)
    })
    pane.container = mainContainer
    siblingPane.container = setupContainer
    ;(
      pane.fitAddon as unknown as {
        proposeDimensions: () => { cols: number; rows: number }
      }
    ).proposeDimensions = vi.fn(() => proposedGrid)
    pane.fitAddon.fit = vi.fn(() => {
      pane.terminal.cols = proposedGrid.cols
      pane.terminal.rows = proposedGrid.rows
    })

    const manager = createManager(1)
    manager.getPanes = vi.fn(() => panes)
    connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        startup: { command: 'codex', waitForSetupSplitDirection: 'vertical' }
      }) as never
    )

    runNextFrame()
    for (let i = 0; i < 8; i++) {
      runNextFrame()
    }
    expect(transport.connect).not.toHaveBeenCalled()

    splitMounted = true
    panes = [pane, siblingPane]
    proposedGrid = { cols: 120, rows: 50 }
    let postSplitFrames = 0
    while (frameCallbacks.length > 0 && transport.connect.mock.calls.length === 0) {
      if (postSplitFrames >= 12) {
        throw new Error('startup did not connect after setup split became ready')
      }
      postSplitFrames += 1
      runNextFrame()
    }

    expect(createdTransportOptions[0]?.command).toBe('codex')
    expect(transport.connect).toHaveBeenCalledWith(expect.objectContaining({ cols: 120, rows: 50 }))
  })

  it('spawns the delayed main setup-split pane when its sibling owns the tab PTY fallback', async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    const runNextFrame = (): void => {
      const callback = frameCallbacks.shift()
      if (!callback) {
        throw new Error('expected a queued animation frame')
      }
      callback(0)
    }

    const { connectPanePty } = await import('./pty-connection')
    let mainPtyId: string | null = null
    const mainTransport = createMockTransport()
    mainTransport.getPtyId.mockImplementation(() => mainPtyId)
    mainTransport.attach.mockImplementation(({ existingPtyId }: { existingPtyId: string }) => {
      mainPtyId = existingPtyId
    })
    mainTransport.connect.mockImplementation(async () => {
      mainPtyId = 'pty-main'
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.(mainPtyId)
      return mainPtyId
    })
    let setupPtyId: string | null = null
    const setupTransport = createMockTransport()
    setupTransport.getPtyId.mockImplementation(() => setupPtyId)
    setupTransport.connect.mockImplementation(async () => {
      setupPtyId = 'pty-setup'
      const onPtySpawn = createdTransportOptions[1]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.(setupPtyId)
      return setupPtyId
    })
    transportFactoryQueue.push(mainTransport, setupTransport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }
    const updateStoreTabPtyId = vi.fn((_tabId: string, ptyId: string) => {
      mockStoreState.tabsByWorktree['wt-1'][0].ptyId = ptyId
      const livePtyIds = mockStoreState.ptyIdsByTabId?.['tab-1'] ?? []
      if (!livePtyIds.includes(ptyId)) {
        livePtyIds.push(ptyId)
      }
    })

    const mainPane = createPane(1)
    const setupPane = createPane(2)
    let splitMounted = false
    const root = createMeasuredElement({ rect: () => createRect(1200, 800) })
    const split = createMeasuredElement({
      className: () => (splitMounted ? 'pane-split is-vertical' : ''),
      rect: () => createRect(1200, 800)
    })
    const mainContainer = createMeasuredElement({
      parentElement: () => (splitMounted ? split : root),
      rect: () => (splitMounted ? createRect(600, 800) : createRect(1200, 800))
    })
    const setupContainer = createMeasuredElement({
      parentElement: () => split,
      rect: () => createRect(599, 800, 601, 0)
    })
    mainPane.container = mainContainer
    setupPane.container = setupContainer
    const manager = createManager(2)
    manager.getPanes = vi.fn(() => [mainPane, setupPane])
    const sharedTransportsRef = { current: new Map() }

    connectPanePty(
      mainPane as never,
      manager as never,
      createDeps({
        startup: { command: 'codex', waitForSetupSplitDirection: 'vertical' },
        paneTransportsRef: sharedTransportsRef,
        updateTabPtyId: updateStoreTabPtyId
      }) as never
    )
    connectPanePty(
      setupPane as never,
      manager as never,
      createDeps({
        startup: { command: 'bash setup-runner.sh' },
        paneTransportsRef: sharedTransportsRef,
        updateTabPtyId: updateStoreTabPtyId
      }) as never
    )

    for (let frame = 0; frame < 40 && setupTransport.connect.mock.calls.length === 0; frame++) {
      runNextFrame()
    }
    expect(setupTransport.connect).toHaveBeenCalledTimes(1)
    expect(mockStoreState.tabsByWorktree['wt-1'][0].ptyId).toBe('pty-setup')
    expect(mainTransport.connect).not.toHaveBeenCalled()

    splitMounted = true
    for (
      let frame = 0;
      frame < 20 &&
      mainTransport.connect.mock.calls.length === 0 &&
      mainTransport.attach.mock.calls.length === 0;
      frame++
    ) {
      runNextFrame()
    }

    expect(mainTransport.attach).not.toHaveBeenCalled()
    expect(mainTransport.connect).toHaveBeenCalledTimes(1)
    expect(mainTransport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(createdTransportOptions[0]?.command).toBe('codex')
    expect(createdTransportOptions[1]?.command).toBe('bash setup-runner.sh')
    expect(mainPtyId).toBe('pty-main')
    expect(setupPtyId).toBe('pty-setup')
  })

  it('does not reuse a sibling split pane pending spawn after remount', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const mainSpawn = createDeferred<string>()
    const setupSpawn = createDeferred<string>()

    const mainTransport = createMockTransport()
    mainTransport.connect.mockImplementation(async () => mainSpawn.promise)
    const setupTransport = createMockTransport()
    setupTransport.connect.mockImplementation(async () => setupSpawn.promise)
    const remountTransport = createMockTransport()
    transportFactoryQueue.push(mainTransport, setupTransport, remountTransport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const sharedTransportsRef = { current: new Map() }
    connectPanePty(
      createPane(1) as never,
      createManager(2) as never,
      createDeps({ paneTransportsRef: sharedTransportsRef }) as never
    )
    connectPanePty(
      createPane(2) as never,
      createManager(2) as never,
      createDeps({
        startup: { command: 'bash setup-runner.sh' },
        paneTransportsRef: sharedTransportsRef
      }) as never
    )

    const remountDeps = createDeps()
    const remountPane = createPane(1)
    connectPanePty(remountPane as never, createManager(2) as never, remountDeps as never)

    setupSpawn.resolve('pty-setup')
    mainSpawn.resolve('pty-main')
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(remountTransport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'pty-main' })
    )
    expect(remountPane.container.dataset.ptyId).toBe('pty-main')
    expect(remountDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-main')
    expect(remountDeps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-main')
  })

  it('binds a fresh spawn that resolves as a daemon reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    let currentPtyId: string | null = null
    const transport = createMockTransport()
    transport.getPtyId.mockImplementation(() => currentPtyId)
    transport.connect.mockImplementation(async () => {
      currentPtyId = 'pty-daemon-reattach'
      return { id: currentPtyId, isReattach: true }
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    }

    const pane = createPane(1)
    const deps = createDeps()

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(pane.container.dataset.ptyId).toBe('pty-daemon-reattach')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-daemon-reattach')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'pty-daemon-reattach')
  })

  it('drops xterm onData while pane is replaying restored bytes', async () => {
    // Regression: during replay, xterm auto-replies to embedded queries (DA1/DECRQM/OSC/CPR) via onData must not reach transport.sendInput or they land as stray chars on the prompt. See replay-guard.ts.
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-live')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const replayingPanesRef = { current: new Map<number, number>([[1, 1]]) }
    const deps = createDeps({ replayingPanesRef })
    const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    // Simulate xterm emitting a DA1 auto-reply during replay parse.
    ;(onDataHandler as (data: string) => void)('\x1b[?1;2c')
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.claimViewport).not.toHaveBeenCalled()

    // Once replay completes (guard cleared), real keystrokes flow through.
    replayingPanesRef.current.delete(1)
    setFitOverride('pty-live', 'remote-desktop-fit', 80, 24)
    ;(onDataHandler as (data: string) => void)('a')
    expect(transport.sendInput).toHaveBeenCalledWith('a')
    expect(transport.claimViewport).toHaveBeenCalledTimes(1)
    ;(onDataHandler as (data: string) => void)('b')
    // The renderer stays parked until runtime convergence is acknowledged, so a second keystroke can retry a transient failed resize.
    expect(transport.claimViewport).toHaveBeenCalledTimes(2)
    setFitOverride('pty-live', 'desktop-fit', 0, 0)
  })

  it('does not enumerate every worktree tab for ordinary input without Codex restart notices', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport('pty-live')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {}
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('uses the current worktree tab for Codex stale fallback without enumerating all worktrees', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {
        'pty-other': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  it('blocks stale Codex fallback input from the current worktree tab without enumerating all worktrees', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: new Proxy(
        {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-live' }],
          'wt-2': [{ id: 'tab-2', ptyId: 'pty-other' }]
        },
        {
          ownKeys() {
            throw new Error('tabsByWorktree should not be enumerated')
          }
        }
      ),
      codexRestartNoticeByPtyId: {
        'pty-live': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('blocks input to stale Codex panes until they restart', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const transport = createMockTransport('pty-codex-stale')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-codex-stale' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-codex-stale']
      },
      codexRestartNoticeByPtyId: {
        'pty-codex-stale': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      },
      agentStatusByPaneKey: {
        [makePaneKey('tab-1', LEAF_1)]: {
          paneKey: makePaneKey('tab-1', LEAF_1),
          state: 'working',
          prompt: 'stale input',
          updatedAt: 1_000,
          stateStartedAt: 900,
          agentType: 'codex',
          stateHistory: []
        }
      }
    }

    const pane = createPane(1)
    const terminalTarget = createKeyboardEventTarget()
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    const sendTerminalInput = onDataHandler as (data: string) => void
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    sendTerminalInput('\x03')
    vi.advanceTimersByTime(500)

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('does not infer interrupts when mobile presence lock blocks terminal input', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const ptyId = 'pty-mobile-locked'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        ptyIdsByTabId: { 'tab-1': [ptyId] },
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            state: 'working',
            prompt: 'locked input',
            updatedAt: 1_000,
            stateStartedAt: 900,
            agentType: 'codex',
            stateHistory: []
          }
        }
      }

      const pane = createPane(1)
      const terminalTarget = createKeyboardEventTarget()
      ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
      ;(onDataHandler as unknown as (data: string) => void)('\x03')
      ;(onDataHandler as unknown as (data: string) => void)('x')
      vi.advanceTimersByTime(500)

      expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('drops xterm protocol replies from live TUI output while mobile presence lock is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    const ptyId = 'pty-mobile-tui-query'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        ptyIdsByTabId: { 'tab-1': [ptyId] }
      }

      const pane = createPane(1)
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      // Simulate xterm answering a TUI's DA1 query while the phone owns the PTY.
      ;(onDataHandler as unknown as (data: string) => void)('\x1b[?1;2c')
      // Capability handlers are registered outside onData and must honor the same mobile query-authority lock.
      const csiCalls = (
        pane.terminal.parser.registerCsiHandler as unknown as {
          mock: { calls: [{ final: string }, (params: (number | number[])[]) => boolean][] }
        }
      ).mock.calls
      const da1Handler = csiCalls.find(([id]) => id.final === 'c')?.[1]
      expect(da1Handler).toBeTypeOf('function')
      da1Handler?.([])
      await flushAsyncTicks()

      expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(transport.sendInputImmediate).not.toHaveBeenCalled()
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('blocks remote locked terminal input before it reaches the runtime transport', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')

    const ptyId = 'remote:env-1@@terminal-1'
    setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone-1' })
    try {
      const transport = createMockTransport(ptyId)
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        ptyIdsByTabId: { 'tab-1': [ptyId] }
      }

      const pane = createPane(1)
      let onDataHandler: ((data: string) => void) | null = null
      pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
        onDataHandler = handler
        return { dispose: vi.fn() }
      }) as typeof pane.terminal.onData)

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      if (!onDataHandler) {
        throw new Error('expected onData handler to be registered')
      }
      ;(onDataHandler as unknown as (data: string) => void)('x')
      await flushAsyncTicks()

      expect(window.api.runtime.restoreTerminalFit).not.toHaveBeenCalled()
      expect(transport.sendInput).not.toHaveBeenCalled()
    } finally {
      setDriverForPty(ptyId, { kind: 'idle' })
    }
  })

  it('does not infer interrupts when the transport rejects terminal input', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const transport = createMockTransport('pty-disconnected')
    transport.sendInput.mockReturnValue(false)
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'working',
      prompt: 'disconnected input',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      stateHistory: []
    }

    const pane = createPane(1)
    const terminalTarget = createKeyboardEventTarget()
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    vi.advanceTimersByTime(500)

    expect(transport.sendInput).toHaveBeenCalledWith('\x03')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('does not infer interrupts when the main process rejects acknowledged input', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const transport = createMockTransport('pty-mobile-race')
    transport.sendInputAccepted = vi.fn().mockResolvedValue(false)
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'working',
      prompt: 'mobile race input',
      updatedAt: 1_000,
      stateStartedAt: 900,
      agentType: 'codex',
      stateHistory: []
    }

    const pane = createPane(1)
    const terminalTarget = createKeyboardEventTarget()
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')
    await flushAsyncTicks()
    vi.advanceTimersByTime(500)

    expect(transport.sendInputAccepted).toHaveBeenCalledWith('\x03')
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
  })

  it('blocks input when tab-level ptyId is stale even if panePtyId is null', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const transport = createMockTransport(null)
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-level-pty' }]
      },
      codexRestartNoticeByPtyId: {
        'tab-level-pty': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(onDataHandler).toBeDefined()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('hello')

    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('sends fast startup commands via sendInput for SSH connections', async () => {
    // Capture the setTimeout callback directly so we can fire it without vi.useFakeTimers() (which would also replace beforeEach's rAF mock).
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      // SSH connection: connectionId set; relay gets command metadata for spawn context but the renderer owns fast command delivery.
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        // Why: startup delivery assumes a live connection; a disconnected target routes through the deferred-connect gate instead of spawning synchronously.
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({ startup: { command: "claude 'say test'" } })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(capturedDataCallback.current).not.toBeNull()

      // Simulate shell prompt arriving — queues the debounce timer
      capturedDataCallback.current?.('user@remote $ ')

      // Fire all queued setTimeout callbacks (the debounce)
      for (const fn of pendingTimeouts) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("claude 'say test'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('waits for the SSH shell-ready marker before sending hinted startup commands', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        // Why: startup delivery assumes a live connection; a disconnected target routes through the deferred-connect gate instead of spawning synchronously.
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      expect(transport.sendInput).not.toHaveBeenCalled()

      capturedDataCallback.current?.('\x1b]777;orca-shell-ready\x07user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("codex 'linked issue context'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('orders a startup draft behind xterm focus input when Codex renders its composer', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport('pty-codex')
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-codex'
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'codex',
        launchAgent: 'codex',
        launchConfig: { agentArgs: '', agentEnv: {} },
        launchToken: 'launch-token-1',
        draftPrompt: 'https://github.com/stablyai/orca/issues/42'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()

    // A focused xterm emits CSI I after Codex enables focus reporting; the startup draft must reuse the same transport instead of racing a direct IPC.
    ;(
      pane.terminal.onData as unknown as {
        mock: { calls: [(data: string) => void][] }
      }
    ).mock.calls[0]?.[0]('\x1b[I')
    ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()
    capturedDataCallback.current?.('\x1b[?2004h\x1b[2K› ')
    await flushAsyncTicks()

    expect(transport.sendInputAccepted).toHaveBeenCalledWith(
      '\x1b[200~https://github.com/stablyai/orca/issues/42\x1b[201~'
    )
    expect(transport.sendInput.mock.calls.map(([data]) => data)).toEqual([
      '\x1b[I',
      '\x1b[200~https://github.com/stablyai/orca/issues/42\x1b[201~'
    ])
    expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
    expect(mockStoreState.recordTerminalInput).toHaveBeenCalledOnce()
    expect(mockStoreState.recordTerminalInput).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
  })

  it('does not consume startup draft delivery before deferred connect starts', async () => {
    const { connectPanePty } = await import('./pty-connection')
    globalThis.requestAnimationFrame = vi.fn(() => 1)
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: null }]
    }

    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        startup: {
          command: 'codex',
          launchAgent: 'codex',
          launchConfig: { agentArgs: '', agentEnv: {} },
          launchToken: 'launch-token-1',
          draftPrompt: 'https://github.com/stablyai/orca/issues/42'
        }
      }) as never
    )

    binding.dispose()

    expect(transport.connect).not.toHaveBeenCalled()
    expect(
      beginAgentStartupDeliveryAttempt({
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        launchToken: 'launch-token-1'
      })
    ).toBe(true)
  })

  it('falls back for SSH shell-ready startup commands when no marker arrives', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        // Why: startup delivery assumes a live connection; a disconnected target routes through the deferred-connect gate instead of spawning synchronously.
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      capturedDataCallback.current?.('fish prompt> ')

      expect(transport.sendInput).not.toHaveBeenCalled()
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("codex 'linked issue context'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('falls back for quiet SSH shell-ready startup commands with no output', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        // Why: startup delivery assumes a live connection; a disconnected target routes through the deferred-connect gate instead of spawning synchronously.
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: "codex 'linked issue context'",
          startupCommandDelivery: 'shell-ready'
        }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()
      expect(transport.sendInput).not.toHaveBeenCalled()

      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("codex 'linked issue context'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('waits for shell-ready for SSH Codex native prefill commands without an explicit hint', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        // Why: startup delivery assumes a live connection; a disconnected target routes through the deferred-connect gate instead of spawning synchronously.
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: { command: "codex --prefill 'linked issue context'" }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      capturedDataCallback.current?.('user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      expect(transport.sendInput).not.toHaveBeenCalled()

      capturedDataCallback.current?.('\x1b]777;orca-shell-ready\x07user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith("codex --prefill 'linked issue context'\r")
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('uses the sequenced startup command hint for SSH shell-ready detection', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = {
        current: null
      }
      const transport = createMockTransport('pty-id')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-ssh-1'
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: 'ssh-conn-1' }],
        // Why: startup delivery assumes a live connection; a disconnected target routes through the deferred-connect gate instead of spawning synchronously.
        sshConnectionStates: new Map([['ssh-conn-1', { status: 'connected' }]])
      }

      const wrapperCommand = 'bash -lc wait-for-setup-wrapper'
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: wrapperCommand,
          env: {
            [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: "codex --prefill 'linked issue context'"
          }
        }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      capturedDataCallback.current?.('user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }
      expect(transport.sendInput).not.toHaveBeenCalled()

      capturedDataCallback.current?.('\x1b]777;orca-shell-ready\x07user@remote $ ')
      for (const fn of pendingTimeouts.splice(0)) {
        fn()
      }

      expect(transport.sendInput).toHaveBeenCalledWith(`${wrapperCommand}\r`)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('drops agent status without retaining when OSC 133 reports the command finished', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    let currentPtyId: string | null = null
    vi.mocked(transport.getPtyId).mockImplementation(() => currentPtyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      currentPtyId = 'pty-local-1'
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-local-1'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'done',
          prompt: 'hi',
          updatedAt: 1000,
          stateStartedAt: 1000,
          agentType: 'codex',
          stateHistory: []
        }
      }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ isVisibleRef: { current: false } })

    connectPanePty(pane as never, manager as never, deps as never)

    capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
    await flushAsyncTicks()

    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
    expect(mockStoreState.removeAgentStatus).not.toHaveBeenCalled()
  })

  it('clears pre-hook launch config when an Orca-started command exits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    let currentPtyId: string | null = null
    vi.mocked(transport.getPtyId).mockImplementation(() => currentPtyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      currentPtyId = 'pty-local-1'
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-local-1'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        startup: {
          command: "codex '--dangerously-bypass-approvals-and-sandbox'",
          launchConfig: {
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          },
          launchAgent: 'codex'
        },
        restoredPtyIdByLeafId: {}
      }) as never
    )

    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(
      paneKey,
      {
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      expect.objectContaining({ agentType: 'codex' })
    )
    capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
    await flushAsyncTicks()
    await vi.advanceTimersByTimeAsync(350)
    await flushAsyncTicks()

    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it('routes a manually typed Droid only after foreground enrichment confirms it', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const pane = createPane(1)
    const ptyId = 'pty-manually-typed-droid'
    const tabId = 'tab-manually-typed-droid'
    const foregroundResults = ['powershell.exe', 'droid']
    vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(async (id: string) =>
      id === ptyId ? (foregroundResults.shift() ?? 'droid') : null
    )
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey(tabId, LEAF_1)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({ tabId, isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()

    sendTerminalInputThroughPane(pane, 'droid\r')
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

    dataCallbackRef.current?.('\x1b]133;C\x07')
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
    await vi.advanceTimersByTimeAsync(350)
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
    await vi.advanceTimersByTimeAsync(1200)
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: 'droid',
      routingTrusted: true,
      shellForeground: false
    })
  })

  it('confirms a manually typed Droid without OSC command boundaries', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('droid')
    const pane = createPane(1)
    const ptyId = 'pty-manual-droid-no-osc'
    const tabId = 'tab-manual-droid-no-osc'
    const paneKey = makePaneKey(tabId, LEAF_1)
    transportFactoryQueue.push(createMockTransport(ptyId))

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({ tabId, isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()

    sendTerminalInputThroughPane(pane, 'droid\r')
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

    await vi.advanceTimersByTimeAsync(350)

    expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledWith(ptyId)
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: 'droid',
      routingTrusted: true,
      shellForeground: false
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
  })

  it('confirms an Orca-launched Droid fresh spawn in a no-OSC shell (Git Bash)', async () => {
    // Why: no-OSC shells (Git Bash/cmd) emit no command boundary, so without a fresh-spawn sample the pane never earns routing trust and Shift+Enter regresses to Esc+CR (#7620).
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('droid')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('droid')
    const pane = createPane(1)
    const ptyId = 'pty-launched-droid-no-osc'
    const tabId = 'tab-launched-droid-no-osc'
    const paneKey = makePaneKey(tabId, LEAF_1)
    transportFactoryQueue.push(createMockTransport(ptyId))

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        tabId,
        startup: { command: 'droid', launchAgent: 'droid' }
      }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    // The transport reports the fresh spawn; no OSC 133, no typed inference.
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as ((id: string) => void) | undefined
    expect(onPtySpawn).toBeTypeOf('function')
    onPtySpawn?.(ptyId)
    // Span the bounded confirmation retry ladder while Droid boots.
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    await flushAsyncTicks()

    expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledWith(ptyId)
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: 'droid',
      routingTrusted: true,
      shellForeground: false
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
  })

  it('trusts a launched Droid whose no-OSC boot only becomes foreground after retries', async () => {
    // Why: the confirmation ladder must span Droid's boot — the shell is still foreground on the first read(s) before Droid takes over.
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const foregroundResults = ['bash.exe', 'bash.exe', 'droid']
    vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(
      async () => foregroundResults.shift() ?? 'droid'
    )
    const pane = createPane(1)
    const ptyId = 'pty-launched-droid-slow-boot'
    const tabId = 'tab-launched-droid-slow-boot'
    const paneKey = makePaneKey(tabId, LEAF_1)
    transportFactoryQueue.push(createMockTransport(ptyId))

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({ tabId, startup: { command: 'droid', launchAgent: 'droid' } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as ((id: string) => void) | undefined
    onPtySpawn?.(ptyId)
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    await flushAsyncTicks()

    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: 'droid',
      routingTrusted: true,
      shellForeground: false
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
  })

  it('stays recoverable when a launched Droid outlasts the fresh-spawn confirmation window', async () => {
    // Why: a missed ladder (slow boot) must stay recoverable — latching a shell-confirm would clear launch identity and poison Shift+Enter for the session.
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    let foreground = 'bash.exe'
    vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(async () => foreground)
    const pane = createPane(1)
    const ptyId = 'pty-launched-droid-slow'
    const tabId = 'tab-launched-droid-slow'
    const paneKey = makePaneKey(tabId, LEAF_1)
    transportFactoryQueue.push(createMockTransport(ptyId))

    const binding = connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({ tabId, startup: { command: 'droid', launchAgent: 'droid' } }) as never
    ) as unknown as { sampleForegroundAgentOnFocus: () => void }
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as ((id: string) => void) | undefined
    onPtySpawn?.(ptyId)
    // Whole ladder elapses while the shell is still foreground (Droid not up yet).
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    await flushAsyncTicks()

    // Benign miss: shell never latched as foreground; encoding still safe fallback.
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: null,
      shellForeground: false
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

    // Droid finally boots and a focus event re-samples: trust is recoverable.
    foreground = 'droid'
    binding.sampleForegroundAgentOnFocus()
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    await flushAsyncTicks()

    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: 'droid',
      routingTrusted: true,
      shellForeground: false
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
  })

  it('revokes trusted Droid after accepted no-OSC exit input until shell confirmation', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('cmd.exe')
    const pane = createPane(1)
    const ptyId = 'pty-droid-exit-no-osc'
    const tabId = 'tab-droid-exit-no-osc'
    const paneKey = makePaneKey(tabId, LEAF_1)
    transportFactoryQueue.push(createMockTransport(ptyId))

    connectPanePty(pane as never, createManager(1) as never, createDeps({ tabId }) as never)
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.paneForegroundAgentByPaneKey[paneKey] = {
      agent: 'droid',
      routingTrusted: true,
      shellForeground: false
    }

    sendTerminalInputThroughPane(pane, '\x03')
    await flushAsyncTicks()

    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: 'droid',
      shellForeground: false
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)

    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: null,
      shellForeground: true
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
  })

  it('never promotes typed Droid text when foreground enrichment is unavailable', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('inspection unavailable'))
      .mockResolvedValueOnce(null)
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const pane = createPane(1)
    const ptyId = 'pty-typed-droid-unavailable-start'
    const tabId = 'tab-typed-droid-unavailable-start'
    const paneKey = makePaneKey(tabId, LEAF_1)
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({ tabId, isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()

    sendTerminalInputThroughPane(pane, 'droid\r')
    dataCallbackRef.current?.('\x1b]133;C\x07')
    await vi.advanceTimersByTimeAsync(350)
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

    await vi.advanceTimersByTimeAsync(1200)
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

    await vi.advanceTimersByTimeAsync(5999)
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
    await vi.advanceTimersByTimeAsync(1)

    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
  })

  it.each(['process', 'launch'] as const)(
    'does not let typed Droid input replace another live TUI %s identity',
    async (identitySource) => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const pane = createPane(1)
      const ptyId = `pty-antigravity-${identitySource}-typed-droid`
      const tabId = `tab-antigravity-${identitySource}-typed-droid`
      const paneKey = makePaneKey(tabId, LEAF_1)
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(
        pane as never,
        createManager(1) as never,
        createDeps({ tabId, isVisibleRef: { current: false } }) as never
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      if (identitySource === 'process') {
        mockStoreState.paneForegroundAgentByPaneKey[paneKey] = {
          agent: 'antigravity',
          shellForeground: false
        }
      } else {
        mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
          launchConfig: { agentArgs: '', agentEnv: {} },
          identity: { agentType: 'antigravity' }
        }
      }

      sendTerminalInputThroughPane(pane, 'droid\r')
      dataCallbackRef.current?.('\x1b]133;C\x07')

      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: null,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
    }
  )

  it.each([
    ['SSH', 'ssh:conn@@pty-typed-droid', 'tab-ssh-typed-droid'],
    ['remote runtime', 'remote:web-env-1@@pty-typed-droid', 'tab-remote-typed-droid']
  ])(
    'does not persist typed command process evidence for %s panes',
    async (_label, ptyId, tabId) => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const pane = createPane(1)
      const paneKey = makePaneKey(tabId, LEAF_1)
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(
        pane as never,
        createManager(1) as never,
        createDeps({ tabId, isVisibleRef: { current: false } }) as never
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()

      sendTerminalInputThroughPane(pane, 'droid\r')
      dataCallbackRef.current?.('\x1b]133;C\x07\x1b]133;D;0\x07')

      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toBeUndefined()
      expect(mockStoreState.setPaneForegroundAgent).not.toHaveBeenCalledWith(
        paneKey,
        expect.anything()
      )
    }
  )

  it('keeps Droid routing visible through command-finished foreground confirmation', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    const getForegroundProcess = vi.mocked(window.api.pty.confirmForegroundProcess)
    getForegroundProcess.mockResolvedValue('droid')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-droid-confirmation-window'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }
    mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
      delete mockStoreState.agentLaunchConfigByPaneKey[key]
    })

    const readsBeforeFinish = getForegroundProcess.mock.calls.length
    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    expect(mockStoreState.clearAgentLaunchConfig).not.toHaveBeenCalled()
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

    await vi.advanceTimersByTimeAsync(350)
    expect(mockStoreState.clearAgentLaunchConfig).not.toHaveBeenCalled()
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')

    expect(getForegroundProcess).toHaveBeenCalledTimes(readsBeforeFinish + 1)
    expect(mockStoreState.clearAgentLaunchConfig).not.toHaveBeenCalled()
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: 'droid',
      routingTrusted: true,
      shellForeground: false
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
  })

  it('retires pane launch routing after one fresh scan confirms shell', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('powershell.exe')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-droid-confirmed-shell'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }
    mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
      delete mockStoreState.agentLaunchConfigByPaneKey[key]
    })

    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(350)
    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledExactlyOnceWith(paneKey)
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: null,
      shellForeground: true
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
  })

  it('retires stale routing after unavailable command-finish reads without asserting shell', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue(null)
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-droid-unavailable-finish'
    const tabId = 'tab-droid-unavailable-finish'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey(tabId, LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ tabId, isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }
    mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
      delete mockStoreState.agentLaunchConfigByPaneKey[key]
    })

    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)

    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledExactlyOnceWith(paneKey)
    expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
      agent: null,
      shellForeground: false
    })
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
  })

  it('cancels deferred cleanup on a new command and retires identity at its later shell', async () => {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('powershell.exe')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-droid-superseded-confirmation'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'droid' }
    }
    mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
      delete mockStoreState.agentLaunchConfigByPaneKey[key]
    })

    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    dataCallbackRef.current?.('\x1b]133;C\x07')
    expect(mockStoreState.clearAgentLaunchConfig).not.toHaveBeenCalled()
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)

    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledExactlyOnceWith(paneKey)
    expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
  })

  it('flushes pending interrupt inference before dropping an exited foreground agent command', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    const writeAccepted = createDeferred<boolean>()
    transport.sendInputAccepted = vi.fn(() => writeAccepted.promise)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return { id: 'tab-pty' }
    })
    transport.attach.mockImplementation(({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
    })
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'stop quickly',
          updatedAt: 1_000,
          stateStartedAt: 900,
          agentType: 'codex',
          terminalTitle: 'Codex',
          stateHistory: []
        }
      }
    }
    vi.mocked(window.api.agentStatus.inferInterrupt).mockImplementation(async () => {
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        paneKey,
        state: 'done',
        prompt: 'stop quickly',
        updatedAt: 1_100,
        stateStartedAt: 1_100,
        agentType: 'codex',
        terminalTitle: 'Codex',
        interrupted: true,
        stateHistory: [
          {
            state: 'working',
            prompt: 'stop quickly',
            startedAt: 900
          }
        ]
      }
      return true
    })
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    vi.advanceTimersByTime(1_000)
    await flushAsyncTicks()
    expect(capturedDataCallback.current).not.toBeNull()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(
      keyEvent({
        key: 'c',
        ctrlKey: true
      })
    )
    ;(onDataHandler as unknown as (data: string) => void)('\x03')

    capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
    expect(window.api.agentStatus.inferInterrupt).not.toHaveBeenCalled()
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()

    writeAccepted.resolve(true)
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalledWith({
      paneKey,
      baselineUpdatedAt: 1_000,
      baselineStateStartedAt: 900,
      baselinePrompt: 'stop quickly',
      baselineAgentType: 'codex',
      intent: 'ctrl-c'
    })
    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
  })

  it('drops the command-finished status when pending interrupt inference is rejected', async () => {
    const { connectPanePty } = await import('./pty-connection')

    vi.mocked(window.api.agentStatus.inferInterrupt).mockResolvedValue(false)
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport()
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return { id: 'tab-pty' }
    })
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    vi.setSystemTime(1_100)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'stop quickly',
          updatedAt: 1_000,
          stateStartedAt: 900,
          agentType: 'codex',
          terminalTitle: 'Codex',
          stateHistory: []
        }
      }
    }
    const terminalTarget = createKeyboardEventTarget()
    const pane = createPane(1)
    ;(pane.terminal as { element?: unknown }).element = terminalTarget.target
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    vi.advanceTimersByTime(1_000)
    await flushAsyncTicks()
    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    terminalTarget.dispatch(keyEvent({ key: 'c', ctrlKey: true }))
    ;(onDataHandler as unknown as (data: string) => void)('\x03')

    capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
    await flushAsyncTicks()

    expect(window.api.agentStatus.inferInterrupt).toHaveBeenCalled()
    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
  })

  it('reattaches a remounted split pane to its restored leaf PTY instead of the tab-level PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'leaf-pty-2' }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    // Why: deferred reattach uses connect({ sessionId }) not attach() so the daemon's createOrAttach runs at the pane's real fitAddon dimensions.
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'leaf-pty-2' })
    )
    expect(transport.attach).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'leaf-pty-2')
  })

  it('resizes a reattached PTY to the current grid when the pane narrows before reattach resolves', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<void>()
    let currentPtyId: string | null = null
    const transport = createMockTransport()
    transport.getPtyId.mockImplementation(() => currentPtyId)
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      currentPtyId = sessionId ?? null
      await reattach.promise
      return sessionId ? { id: sessionId } : null
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(2)
    pane.terminal.cols = 133
    pane.terminal.rows = 63
    let proposedGrid = { cols: 133, rows: 63 }
    ;(
      pane.fitAddon as unknown as {
        proposeDimensions: () => { cols: number; rows: number }
      }
    ).proposeDimensions = vi.fn(() => proposedGrid)
    pane.fitAddon.fit = vi.fn(() => {
      pane.terminal.cols = proposedGrid.cols
      pane.terminal.rows = proposedGrid.rows
    })
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'leaf-pty-2' }
    })

    connectPanePty(pane as never, createManager(2) as never, deps as never)

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 133, rows: 63, sessionId: 'leaf-pty-2' })
    )

    proposedGrid = { cols: 65, rows: 63 }
    reattach.resolve()
    await flushAsyncTicks()

    expect(transport.resize).toHaveBeenCalledWith(65, 63)
    expect(transport.resize).toHaveBeenLastCalledWith(65, 63, { claim: true })
  })

  it('adopts a live eager PTY and withholds snapshots after its renderer dies', async () => {
    // Why: a live eager buffer means "attach + replay", not "reattach" — else first mount mis-routes to daemon-reattach and orphans the eager agent PTY.
    const eagerPtyId = 'auto-eager-pty'
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === eagerPtyId ? { flush: () => '', dispose: () => {} } : undefined
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: eagerPtyId }] },
      ptyIdsByTabId: { 'tab-1': [eagerPtyId] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: eagerPtyId }
        }
      }
    } as StoreState
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: eagerPtyId }
    })

    const pane = createPane(1)
    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: eagerPtyId })
    )
    expect(pane.container.dataset.ptyId).toBe(eagerPtyId)
    expect(transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: eagerPtyId })
    )
    const { hasPtySerializer } = await import('./pty-buffer-serializer')
    expect(hasPtySerializer(eagerPtyId)).toBe(true)

    const serializeRequestHandler = (
      window.api.pty.onSerializeBufferRequest as unknown as {
        mock: { calls: [[(request: { requestId: string; ptyId: string }) => void]] }
      }
    ).mock.calls[0]?.[0]
    const { notifyUndeliverableWrite } =
      await import('@/lib/pane-manager/terminal-write-pipeline-health')
    notifyUndeliverableWrite(pane.terminal, 'replay-wedged')
    serializeRequestHandler?.({ requestId: 'dead-renderer', ptyId: eagerPtyId })
    await flushAsyncTicks()

    expect(window.api.pty.sendSerializedBuffer).toHaveBeenCalledWith('dead-renderer', null)
  })

  it('does not adopt another tab live eager PTY from a stale restored leaf binding', async () => {
    // Why: restored leaf bindings can outlive tab ownership; a global eager buffer proves the PTY is alive, ptyIdsByTabId proves this tab owns it.
    const otherTabPtyId = 'other-tab-eager-pty'
    vi.mocked(getEagerPtyBufferHandle).mockImplementation((ptyId: string) =>
      ptyId === otherTabPtyId ? { flush: () => '', dispose: () => {} } : undefined
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        return { id: opts.sessionId }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [
          { id: 'tab-1', ptyId: 'tab-pty' },
          { id: 'tab-2', ptyId: otherTabPtyId }
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['tab-pty'],
        'tab-2': [otherTabPtyId]
      }
    } as StoreState
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: otherTabPtyId }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(transport.attach).not.toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: otherTabPtyId })
    )
    expect(transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: otherTabPtyId })
    )
    expect(deps.updateTabPtyId).not.toHaveBeenCalledWith('tab-1', otherTabPtyId)
  })

  it('spawns a fresh PTY when a restored daemon split session cannot reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        return undefined
      }
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('fresh-pty')
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'stale-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await Promise.resolve()
    await Promise.resolve()

    expect(transport.connect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: 'stale-pty' })
    )
    expect(transport.connect).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'stale-pty')
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'stale-pty')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-pty')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-pty')
  })

  it('reattaches via the tab-level SSH pty id when deferred bookkeeping missed the tab', async () => {
    // Why: restore can miss the deferred maps; the tab's SSH pty id must still drive connect-then-reattach, not a fresh spawn into a missing provider.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'ssh:conn-1@@pty-7' }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map()
    } as StoreState
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(12)

    const windowApi = (globalThis as unknown as { window: { api: { ssh: { connect: unknown } } } })
      .window.api
    expect(windowApi.ssh.connect).toHaveBeenCalledWith({ targetId: 'conn-1' })
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ssh:conn-1@@pty-7' })
    )
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('connects a disconnected SSH target before fresh-spawning instead of erroring', async () => {
    // Why: spawning against a disconnected target throws "No PTY provider" and strands the pane behind a toast that never retries.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-ssh-pty')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map()
    } as StoreState
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    // Why: no spawn may fire before the SSH connection is established.
    expect(transport.connect).not.toHaveBeenCalled()
    await flushAsyncTicks(12)

    const windowApi = (globalThis as unknown as { window: { api: { ssh: { connect: unknown } } } })
      .window.api
    expect(windowApi.ssh.connect).toHaveBeenCalledWith({ targetId: 'conn-1' })
    expect(transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  })

  it('spawns a fresh PTY when a non-deferred SSH reattach reports expired via onError', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(
      async (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (opts.sessionId) {
          opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: restored-session')
          return undefined
        }
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        onPtySpawn?.('fresh-ssh-pty')
        return 'fresh-ssh-pty'
      }
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(10)

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'restored-session')
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'restored-session')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-ssh-pty')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-ssh-pty')
  })

  it('submits a cold-restore resume command after SSH expired-session fallback', async () => {
    const pendingTimeouts: (() => void)[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = vi.fn((fn: () => void) => {
      pendingTimeouts.push(fn)
      return 999 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout

    try {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_2)
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          if (opts.sessionId) {
            opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: restored-session')
            return undefined
          }
          capturedDataCallback.current = opts.callbacks?.onData ?? null
          const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
            | ((ptyId: string) => void)
            | undefined
          onPtySpawn?.('fresh-ssh-pty')
          return 'fresh-ssh-pty'
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
        repos: [{ id: 'repo1', connectionId: 'conn-1' }],
        sshConnectionStates: new Map([['conn-1', { status: 'connected' }]]),
        settings: {
          ...mockStoreState.settings,
          agentCmdOverrides: {}
        },
        sleepingAgentSessionsByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'codex-session-1' },
            prompt: 'finish the task',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      } as StoreState
      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)
      capturedDataCallback.current?.('user@remote $ ')
      for (const fn of pendingTimeouts) {
        fn()
      }

      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(transport.connect).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
          env: expect.objectContaining({
            ORCA_PANE_KEY: paneKey,
            ORCA_TAB_ID: 'tab-1',
            ORCA_WORKTREE_ID: 'wt-1',
            ORCA_WORKSPACE_ID: 'wt-1',
            ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
          })
        })
      )
      expect(transport.sendInput).toHaveBeenCalledWith(
        "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'\r"
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('clears the pending serializer when disposed before non-deferred SSH reattach expiry resolves', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<undefined>()
    const transport = createMockTransport()
    transport.connect.mockImplementation(
      (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (opts.sessionId) {
          opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: restored-session')
          return reattach.promise
        }
        return Promise.resolve('fresh-ssh-pty')
      }
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
    } as StoreState
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
    })

    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)
    binding.dispose()
    reattach.resolve(undefined)
    await flushAsyncTicks(10)

    expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_2),
      1
    )
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('resets reattach renderer state after daemon snapshot replay without applying the full mode reset', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004hrestored snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      },
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H', expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '\x1b[?1004hrestored snapshot',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      POST_REPLAY_REATTACH_RESET,
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      POST_REPLAY_MODE_RESET,
      expect.any(Function)
    )
  })

  it('resizes the pane to the snapshot grid before replaying daemon snapshot bytes (bug #7279)', async () => {
    // Why: the daemon serializes soft-wrapped lines flat, so reattach must resize xterm to the snapshot grid before writing, or rows rewrap wrong.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot: '\x1b[?1004hrestored snapshot',
          snapshotCols: 80,
          snapshotRows: 24
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      }
    } as StoreState

    // createPane opens the pane at 120x40, deliberately different from the daemon snapshot's 80x24 grid.
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    // Pane was resized to the snapshot grid before the snapshot bytes landed.
    expect(pane.terminal.resize).toHaveBeenCalledWith(80, 24)
    const resizeToSnapshotCall = pane.terminal.resize.mock.invocationCallOrder.find(
      (_order, index) => {
        const [cols, rows] = pane.terminal.resize.mock.calls[index]
        return cols === 80 && rows === 24
      }
    )
    const snapshotWriteCall = pane.terminal.write.mock.invocationCallOrder.find(
      (_order, index) => pane.terminal.write.mock.calls[index][0] === '\x1b[?1004hrestored snapshot'
    )
    expect(resizeToSnapshotCall).toBeDefined()
    expect(snapshotWriteCall).toBeDefined()
    expect(resizeToSnapshotCall as number).toBeLessThan(snapshotWriteCall as number)
  })

  it('waits for a recovered destination fit before forwarding its grid or live output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { safeFit } = await import('@/lib/pane-manager/pane-tree-ops')
    const transport = createMockTransport('tab-pty')
    let deliverLiveData = (_data: string): void => {}
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (callbacks?.onData) {
          deliverLiveData = callbacks.onData
        }
        return sessionId
          ? {
              id: sessionId,
              snapshot: 'source-grid snapshot',
              snapshotCols: 80,
              snapshotRows: 24
            }
          : null
      }
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState
    const pane = createPane(1)
    pane.fitAddon.proposeDimensions = vi.fn(() => undefined) as never
    const { parseCallbacks, writes } = captureCallbackTerminalWrites(pane)
    const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    transport.resize.mockClear()
    signalPty.mockClear()
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }
    await flushAsyncTicks(8)

    expect(transport.resize).not.toHaveBeenCalled()
    expect(signalPty).not.toHaveBeenCalledWith('tab-pty', 'SIGWINCH')

    deliverLiveData('live-after-snapshot')
    await flushAsyncTicks(4)
    expect(writes.join('')).not.toContain('live-after-snapshot')

    pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 })) as never
    safeFit(pane as never)
    await flushAsyncTicks(12)

    expect(transport.resize).toHaveBeenCalledWith(120, 40)
    expect(signalPty).toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
    expect(writes.join('')).toContain('live-after-snapshot')
  })

  it('restores a pinned viewport only after a same-size reattach snapshot finishes parsing', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markTerminalFollowOutput, markTerminalPinnedViewport } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
      sessionId
        ? {
            id: sessionId,
            snapshot: 'same-size authoritative snapshot',
            snapshotCols: 120,
            snapshotRows: 40
          }
        : null
    )
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState
    const pane = createPane(1)
    pane.terminal.buffer.active.baseY = 100
    pane.terminal.buffer.active.viewportY = 80
    markTerminalPinnedViewport(pane.terminal)
    const { parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    expect(pane.terminal.scrollToLine).not.toHaveBeenCalled()

    // Model xterm's native pinned state after clear+replay: the old line number is meaningless, but distance-from-bottom is preserved.
    pane.terminal.buffer.active.baseY = 200
    pane.terminal.buffer.active.viewportY = 0
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }
    await flushAsyncTicks(8)

    expect(pane.terminal.scrollToLine).toHaveBeenLastCalledWith(180)
    markTerminalFollowOutput(pane.terminal)
  })

  it('does not apply a queued reattach snapshot after the PTY is replaced', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    const reattachResult = createDeferred<{
      id: string
      snapshot: string
    }>()
    const replayCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return null
        }
        replayCallback.current = callbacks?.onReplayData ?? null
        return reattachResult.promise
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(8)
    replayCallback.current?.('blocking replay')
    await flushAsyncTicks(12)
    expect(writes).toEqual(['\x1b[2J\x1b[3J\x1b[H'])
    reattachResult.resolve({ id: 'tab-pty', snapshot: 'stale authoritative snapshot' })
    await flushAsyncTicks(12)
    const resizeCallsBeforeReplacement = transport.resize.mock.calls.length
    vi.mocked(transport.getPtyId).mockReturnValue('replacement-pty')
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(12)

    expect(writes).not.toContain('stale authoritative snapshot')
    expect(transport.resize).toHaveBeenCalledTimes(resizeCallsBeforeReplacement)
    expect(window.api.pty.signal).not.toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
  })

  it('does not apply a queued reattach snapshot after its PTY exits', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    const reattachResult = createDeferred<{ id: string; snapshot: string }>()
    const replayCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(
      async ({ callbacks }: { callbacks?: ConnectCallbacks }) => {
        replayCallback.current = callbacks?.onReplayData ?? null
        return reattachResult.promise
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(8)
    replayCallback.current?.('blocking replay')
    await flushAsyncTicks(12)
    reattachResult.resolve({ id: 'tab-pty', snapshot: 'dead authoritative snapshot' })
    await flushAsyncTicks(12)
    const resizeCallsBeforeExit = transport.resize.mock.calls.length
    vi.mocked(transport.getPtyId).mockReturnValue(null)
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(12)

    expect(writes).not.toContain('dead authoritative snapshot')
    expect(transport.resize).toHaveBeenCalledTimes(resizeCallsBeforeExit)
    expect(window.api.pty.signal).not.toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
    expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
  })

  it('drops stale callbacks but delivers fresh replacement output after an old replay clear', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getTerminalScrollIntentKind, markTerminalPinnedViewport } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    const oldResult = createDeferred<undefined>()
    const oldCallbacks: { current: ConnectCallbacks | null } = { current: null }
    const replacementCallbacks: { current: ConnectCallbacks | null } = { current: null }
    let connectCount = 0
    transport.connect.mockImplementation(
      async ({ callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        connectCount += 1
        if (connectCount === 1) {
          oldCallbacks.current = callbacks ?? null
          return oldResult.promise
        }
        vi.mocked(transport.getPtyId).mockReturnValue('replacement-pty')
        replacementCallbacks.current = callbacks ?? null
        return 'replacement-pty'
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.buffer.active.viewportY = 80
    pane.terminal.buffer.active.baseY = 100
    markTerminalPinnedViewport(pane.terminal)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(8)
    oldCallbacks.current?.onReplayData?.('old replay')
    await flushAsyncTicks(8)
    parseCallbacks.shift()?.()
    await flushAsyncTicks(8)
    oldCallbacks.current?.onError?.('SSH_SESSION_EXPIRED: tab-pty')
    oldResult.resolve(undefined)
    await flushAsyncTicks(20)
    expect(replacementCallbacks.current).not.toBeNull()

    replacementCallbacks.current?.onData?.('B-PROMPT')
    oldCallbacks.current?.onData?.('STALE-A')
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(20)

    expect(writes).toContain('B-PROMPT')
    expect(writes).not.toContain('STALE-A')
    expect(pane.terminal.scrollToBottom).toHaveBeenCalled()
    expect(getTerminalScrollIntentKind(pane.terminal)).toBe('followOutput')
  })

  it('retries a fresh-spawn native follow reset when renderer dimensions return', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getTerminalScrollIntentKind } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('fresh-pty')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] }
    } as StoreState
    const pane = createPane(1)
    pane.terminal.buffer.active.viewportY = 40
    pane.terminal.buffer.active.baseY = 100
    const renderListener: { current: (() => void) | null } = { current: null }
    const renderDisposable = { dispose: vi.fn() }
    pane.terminal.onRender = vi.fn((listener: () => void) => {
      renderListener.current = listener
      return renderDisposable
    })
    vi.mocked(pane.terminal.scrollToBottom)
      .mockImplementationOnce(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'dimensions')")
      })
      .mockImplementation(() => {
        pane.terminal.buffer.active.viewportY = pane.terminal.buffer.active.baseY
      })

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks()
    expect(pane.terminal.buffer.active.viewportY).toBe(40)
    expect(renderListener.current).not.toBeNull()

    renderListener.current?.()
    expect(pane.terminal.buffer.active.viewportY).toBe(100)
    expect(pane.terminal.scrollToBottom).toHaveBeenCalledTimes(2)
    expect(getTerminalScrollIntentKind(pane.terminal)).toBe('followOutput')
    expect(renderDisposable.dispose).toHaveBeenCalledTimes(1)
  })

  it('writes the daemon pendingEscapeTailAnsi after the reset on local reattach (#7329)', async () => {
    // Why: re-arm the mid-escape tail LAST, after the reattach reset whose ESC would abort it, so a live continuation completes it.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot: 'restored snapshot',
          snapshotCols: 80,
          snapshotRows: 24,
          pendingEscapeTailAnsi: '\x1b[3'
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    const tailWriteCall = pane.terminal.write.mock.invocationCallOrder.find(
      (_order, index) => pane.terminal.write.mock.calls[index][0] === '\x1b[3'
    )
    const resetWriteCall = pane.terminal.write.mock.invocationCallOrder.find((_order, index) =>
      String(pane.terminal.write.mock.calls[index][0]).includes(POST_REPLAY_REATTACH_RESET)
    )
    expect(tailWriteCall).toBeDefined()
    expect(resetWriteCall).toBeDefined()
    // The dangling tail is written AFTER the reset.
    expect(resetWriteCall as number).toBeLessThan(tailWriteCall as number)
  })

  it('routes native onData query replies through sendInputImmediate, typed input through sendInput (#7329)', async () => {
    // Why this test: the mock aliases sendInputImmediate to sendInput, so other tests can't tell them apart; this pins the routing decision.
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const pane = createPane(1)
    const transport = createMockTransport('remote:web-env-1@@pty-7329')
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()

    // xterm answers CSI 6n natively with a CPR via onData; it must take the immediate path (skips the remote 8ms debounce that corrupted it).
    sendTerminalInputThroughPane(pane, '\x1b[3;1R')
    expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[3;1R')

    // Ordinary typed input must stay on the debounced path — never immediate.
    transport.sendInputImmediate.mockClear()
    sendTerminalInputThroughPane(pane, 'yes')
    sendTerminalInputThroughPane(pane, '\x1b[A') // arrow-key auto-repeat stays batched
    expect(transport.sendInput).toHaveBeenCalledWith('yes')
    expect(transport.sendInput).toHaveBeenCalledWith('\x1b[A')
    expect(transport.sendInputImmediate).not.toHaveBeenCalled()

    // terminal-query-reply.test proves real xterm emits this as one framed onData reply; this pins it to the immediate path.
    transport.sendInputImmediate.mockClear()
    const xtversionReply = '\x1bP>|xterm.js(6.1.0-beta.287)\x1b\\'
    sendTerminalInputThroughPane(pane, xtversionReply)
    expect(transport.sendInputImmediate).toHaveBeenCalledWith(xtversionReply)

    // Printable input is user-owned: remote cooked echo returns via PTY output, not onData, so OSC-looking text stays on normal input.
    transport.sendInput.mockClear()
    transport.sendInputImmediate.mockClear()
    const printableInputs = [']10;hello', '>|xterm.js(6.1.0-beta.287)', ']|literal-text']
    for (const data of printableInputs) {
      sendTerminalInputThroughPane(pane, data)
      expect(transport.sendInput).toHaveBeenCalledWith(data)
    }
    expect(transport.sendInputImmediate).not.toHaveBeenCalled()
  })

  it('writes the onReplayData pendingEscapeTailAnsi meta last, after the replayed bytes (#7329)', async () => {
    // Why this test: the onReplayData meta pass-through had no failing test — severing it kept the suite green.
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const pane = createPane(1)
    const writes: string[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    }) as typeof pane.terminal.write
    const transport = createMockTransport('remote:web-env-1@@pty-7329-tail')
    const replayCallback: {
      current:
        | ((
            data: string,
            meta?: { clearBeforeReplay?: boolean; pendingEscapeTailAnsi?: string }
          ) => void)
        | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      replayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:web-env-1@@pty-7329-tail', replay: '' }
    })
    transportFactoryQueue.push(transport)
    const manager = createManager(1, 1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    expect(replayCallback.current).toBeTypeOf('function')

    replayCallback.current?.('remote snapshot bytes', {
      clearBeforeReplay: false,
      pendingEscapeTailAnsi: '\x1b[3'
    })
    await flushAsyncTicks(20)

    const snapshotIndex = writes.indexOf('remote snapshot bytes')
    const tailIndex = writes.lastIndexOf('\x1b[3')
    expect(snapshotIndex).toBeGreaterThanOrEqual(0)
    expect(tailIndex).toBeGreaterThanOrEqual(0)
    // The dangling tail is re-armed after the snapshot/reset, so the next live chunk completes it instead of rendering literally.
    expect(tailIndex).toBeGreaterThan(snapshotIndex)
    expect(writes.slice(tailIndex + 1)).toEqual([])
  })

  it('preserves live modes and injects focus-in after focused agent reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25lrestored cursor snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('Cursor Agent')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    // Why: public xterm modes plus an agent title are the stable signal for a live focus-driven TUI; avoid private `_core` probes.
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
      // Snapshot ends with ?25l (Cursor Agent parks/hides the cursor); the reset must preserve it, not force ?25h, or a stray block paints.
      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
      const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map(
        ([data]) => data as string
      )
      expect(writes.some((data) => data.includes('\x1b[?25h'))).toBe(false)
    })
  })

  it('keeps ?25h in the live agent reattach reset when the snapshot leaves the cursor visible', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        // A mid-frame snapshot cut after the TUI re-showed its cursor.
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25l\x1b[?25hrestored cursor snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('Cursor Agent')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
    })
  })

  it('does not inject focus-in after reattach when the terminal does not own DOM focus', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25lrestored cursor snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('Cursor Agent')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    // Why: a different element owns focus, so the reattach must not send a stray focus-in to a background pane.
    await withMockedDocumentActiveElement({}, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
    })
  })

  it('resets stale focus and cursor modes for a focused non-agent shell reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25lstale shell snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('zsh')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_REATTACH_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
    })
  })

  it('does not treat persisted tab launchAgent metadata as a live agent reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25lstale shell snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    // Why: launchAgent is launch-ownership metadata that never decays; it must not preserve stale modes for a shell left after agent death.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', title: 'zsh', launchAgent: 'claude' }]
      },
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: 'zsh' }
      }
    } as StoreState

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_REATTACH_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
    })
  })

  it('does not treat an agent-name token in a shell title as a live agent reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: '\x1b[?1004h\x1b[?25lstale shell snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    // Why: broad token matching would classify this ordinary ssh title as an agent and preserve stale modes into a bare shell.
    setReattachPaneTitle('ssh devin@host')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_REATTACH_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
    })
  })

  it('does not treat ordinary shell scrollback mentioning Cursor Agent as a live agent reattach', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot:
            '\x1b[?1004h\x1b[?25l$ grep -R "Cursor Agent" docs\r\nCursor Agent IME notes\r\n'
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('zsh')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    await withMockedDocumentActiveElement(textarea, async () => {
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_REATTACH_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
    })
  })

  it('resets an already-idle agent cursor again after reattach SIGWINCH repaint', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: 'restored idle codex snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', title: 'Codex done' }]
      },
      runtimePaneTitlesByTabId: {
        'tab-1': { 1: 'Codex done' }
      },
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(window.api.pty.signal).toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )

    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  // Why: a reattach with both snapshot and replay paints the same tail twice (dup-TUI-output on switch); snapshot wins by precedence.
  it('paints only the daemon snapshot when reattach result includes both snapshot and replay', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          snapshot: 'snapshot-payload',
          replay: 'replay-payload'
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith('snapshot-payload', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith('replay-payload', expect.any(Function))
  })

  it('paints only relay replay when reattach result has replay and coldRestore but no snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: sessionId,
          replay: 'replay-payload',
          coldRestore: { scrollback: 'cold-payload' }
        }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith('replay-payload', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith('cold-payload', expect.any(Function))
    // Why: the replay branch supersedes cold-restore but must still ack, or the daemon redelivers the cold-restore payload next reattach.
    expect(window.api.pty.ackColdRestore).toHaveBeenCalledWith('tab-pty')
  })

  it('blanks restored scrollback before fresh shell output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    const written: string[] = []
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      callbacks.onData?.('PS >')
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    } as StoreState

    const pane = createPane(1)
    pane.terminal.rows = 4
    pane.terminal.cols = 20
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      written.push(data)
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps({
      restoredViewportBlankingPanesRef: { current: new Set([1]) }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    const blankViewport = buildFreshShellViewportBlankingSequence(4)
    expect(written).toContain(blankViewport)
    expect(written.indexOf(blankViewport)).toBeLessThan(written.indexOf('PS >'))

    const rendered = await renderHeadlessTerminalState(
      ['old TUI row with a long tail\r\nold TUI row two', blankViewport, 'PS >'],
      20,
      4
    )
    expect(rendered.baseY).toBeGreaterThan(0)
    expect(rendered.allLines.some((line) => line.includes('old TUI row'))).toBe(true)
    expect(rendered.visibleLines).toEqual(['PS >', '', '', ''])
  })

  it('cold-restores at the recovered grid and clears only the dirty viewport before blanking', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    const written: string[] = []
    const operations: (
      | { kind: 'write'; data: string }
      | { kind: 'resize'; cols: number; rows: number }
    )[] = []
    const destinationCols = 10
    const destinationRows = 5
    const recoveredCols = 20
    const recoveredRows = 3
    const coldScrollback = '\x1b[1;1HCOLD\x1b[1;15HEND\r\nCOLD_SOURCE_ROW_02'
    const viewportClear = '\x1b[2J\x1b[H'
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: {
            scrollback: coldScrollback,
            cwd: '/tmp/wt-1',
            cols: recoveredCols,
            rows: recoveredRows
          }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      }
    } as StoreState

    const pane = createPane(1)
    pane.terminal.rows = destinationRows
    pane.terminal.cols = destinationCols
    let sawViewportClear = false
    const preResizeBarrier = { release: null as (() => void) | null }
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      written.push(data)
      operations.push({ kind: 'write', data })
      if (data === viewportClear) {
        sawViewportClear = true
      } else if (sawViewportClear && data === '' && preResizeBarrier.release === null) {
        preResizeBarrier.release = callback ?? (() => {})
        return
      }
      callback?.()
    })
    pane.terminal.resize = vi.fn((cols: number, rows: number) => {
      operations.push({ kind: 'resize', cols, rows })
      pane.terminal.cols = cols
      pane.terminal.rows = rows
    })
    const manager = createManager(1)
    pane.fitAddon.proposeDimensions = vi.fn(() => ({
      cols: destinationCols,
      rows: destinationRows
    }))
    pane.fitAddon.fit = vi.fn(() => {
      pane.terminal.resize(destinationCols, destinationRows)
    })
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    expect(preResizeBarrier.release).not.toBeNull()
    expect(pane.terminal.resize).not.toHaveBeenCalledWith(recoveredCols, recoveredRows)
    expect(written).not.toContain(coldScrollback)

    preResizeBarrier.release?.()
    await flushAsyncTicks(20)

    const blankViewport = buildFreshShellViewportBlankingSequence(destinationRows)
    expect(pane.terminal.resize).toHaveBeenCalledWith(recoveredCols, recoveredRows)
    expect(transport.resize).not.toHaveBeenCalledWith(recoveredCols, recoveredRows)
    expect(transport.resize).toHaveBeenCalledWith(destinationCols, destinationRows)
    expect(transport.resize).toHaveBeenLastCalledWith(destinationCols, destinationRows, {
      claim: true
    })
    expect(written).toContain(viewportClear)
    expect(written).not.toContain('\x1b[2J\x1b[3J\x1b[H')
    expect(written).toEqual(
      expect.arrayContaining([coldScrollback, POST_REPLAY_MODE_RESET, blankViewport])
    )
    expect(written.indexOf(viewportClear)).toBeLessThan(written.indexOf(coldScrollback))
    expect(written.indexOf(coldScrollback)).toBeLessThan(written.indexOf(blankViewport))
    const viewportClearOperation = operations.findIndex(
      (operation) => operation.kind === 'write' && operation.data === viewportClear
    )
    const recoveredResizeOperation = operations.findIndex(
      (operation) =>
        operation.kind === 'resize' &&
        operation.cols === recoveredCols &&
        operation.rows === recoveredRows
    )
    expect(viewportClearOperation).toBeLessThan(recoveredResizeOperation)

    // Model the real op order: the old path appended a 20-col snapshot onto a dirty 10-col xterm, wrapping rows at the wrong grid.
    const rendered = new Terminal({
      cols: destinationCols,
      rows: destinationRows,
      allowProposedApi: true
    })
    try {
      await writeHeadlessTerminal(
        rendered,
        'KEEP_1\r\nKEEP_2\r\nOLD_ROW_1\r\nOLD_ROW_2\r\nOLD_ROW_3\r\nOLD_ROW_4\r\nOLD_ROW_5'
      )
      let replayedAtRecoveredGrid = false
      let sourceGridLines: string[] = []
      for (const operation of operations) {
        if (operation.kind === 'resize') {
          if (
            replayedAtRecoveredGrid &&
            operation.cols === destinationCols &&
            operation.rows === destinationRows &&
            sourceGridLines.length === 0
          ) {
            sourceGridLines = Array.from(
              { length: rendered.buffer.active.length },
              (_, lineIndex) =>
                rendered.buffer.active.getLine(lineIndex)?.translateToString(true) ?? ''
            )
          }
          rendered.resize(operation.cols, operation.rows)
          if (operation.cols === recoveredCols && operation.rows === recoveredRows) {
            replayedAtRecoveredGrid = true
          }
        } else {
          await writeHeadlessTerminal(rendered, operation.data)
        }
      }
      if (sourceGridLines.length === 0) {
        sourceGridLines = Array.from(
          { length: rendered.buffer.active.length },
          (_, lineIndex) => rendered.buffer.active.getLine(lineIndex)?.translateToString(true) ?? ''
        )
      }
      expect(sourceGridLines).toContain('COLD          END')
      if (rendered.cols !== destinationCols || rendered.rows !== destinationRows) {
        rendered.resize(destinationCols, destinationRows)
      }
      await writeHeadlessTerminal(rendered, 'PS >')
      const buffer = rendered.buffer.active
      const lines = Array.from({ length: buffer.length }, (_, lineIndex) =>
        buffer.getLine(lineIndex)?.translateToString(true)
      )
      const logicalLines: string[] = []
      for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
        const line = buffer.getLine(lineIndex)
        const text = line?.translateToString(true) ?? ''
        if (line?.isWrapped && logicalLines.length > 0) {
          logicalLines[logicalLines.length - 1] += text
        } else {
          logicalLines.push(text)
        }
      }
      const visibleLines = Array.from({ length: rendered.rows }, (_, row) =>
        buffer.getLine(buffer.viewportY + row)?.translateToString(true)
      )
      expect(buffer.baseY).toBeGreaterThan(0)
      expect(lines.some((line) => line?.includes('OLD_ROW_'))).toBe(false)
      expect(lines.some((line) => line?.includes('KEEP_1'))).toBe(true)
      expect(lines.some((line) => line?.includes('KEEP_2'))).toBe(true)
      expect(logicalLines.some((line) => /COLD\s+END/.test(line))).toBe(true)
      expect(logicalLines.some((line) => line.includes('COLD_SOURCE_ROW_02'))).toBe(true)
      expect(visibleLines).toEqual(['PS >', '', '', '', ''])
    } finally {
      rendered.dispose()
    }
  })

  it('resumes the provider agent session when daemon reattach cold-restores a fresh shell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          paneKey,
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: {
            key: 'session_id',
            id: 'codex-session-1',
            transcriptPath: '/Users/example/.codex/sessions/2026/07/20/rollout-session.jsonl'
          }
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('cold-payload', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('--- session restored ---'),
      expect.any(Function)
    )
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
        resumeProviderSession: {
          key: 'session_id',
          id: 'codex-session-1',
          transcriptPath: '/Users/example/.codex/sessions/2026/07/20/rollout-session.jsonl'
        },
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
  })

  it('uses WSL quoting for cold-restored agent resume in Windows-path WSL projects', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: 'C:\\tmp\\wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {},
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      },
      projects: [
        {
          id: 'repo1',
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ],
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: 'C:\\tmp\\wt-1',
            displayName: 'feat/notis'
          }
        ]
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          paneKey,
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: "codex-session-1's" }
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('cold-payload', expect.any(Function))
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command:
          "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'\\''s'",
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
  })

  it('resumes from the quit-captured sleeping record when cold-restoring after an app restart', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    // Why: after restart agentStatusByPaneKey is empty — the persisted sleeping record is the only provider session id source (#5232).
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('cold-payload', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('--- session restored ---'),
      expect.any(Function)
    )
    const writeCalls = pane.terminal.write.mock.calls.map(([data]) => data)
    expect(writeCalls.findIndex((data) => data.includes('--- session restored ---'))).toBe(-1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1)
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
    // Why: consuming the record prevents a later worktree activation from launching a duplicate resume tab.
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
  })

  it('resumes from an unambiguous legacy sleeping record when cold-restoring a preserved pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const legacyPaneKey = 'tab-1:2'
    const duplicateLegacyPaneKey = 'tab-1:3'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [legacyPaneKey]: {
          paneKey: legacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        },
        [duplicateLegacyPaneKey]: {
          paneKey: duplicateLegacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 2,
          updatedAt: 2
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('cold-payload', expect.any(Function))
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1)
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'"
      })
    )
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(legacyPaneKey)
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(duplicateLegacyPaneKey)
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[legacyPaneKey]).toBeUndefined()
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[duplicateLegacyPaneKey]).toBeUndefined()
  })

  it('does not choose a non-exact legacy record when same-tab provider sessions differ', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const firstLegacyPaneKey = 'tab-1:2'
    const secondLegacyPaneKey = 'tab-1:3'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [firstLegacyPaneKey]: {
          paneKey: firstLegacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        },
        [secondLegacyPaneKey]: {
          paneKey: secondLegacyPaneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-2' },
          prompt: 'finish another task',
          state: 'working',
          capturedAt: 2,
          updatedAt: 2
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('cold-payload', expect.any(Function))
    expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining('resume') })
    )
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('uses sleeping-record launch config for pane cold restore after settings change', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const launchConfig = {
      agentCommand: "codex '--model' 'gpt-5' '--reasoning-effort' 'high'",
      agentArgs: '--model gpt-5 --reasoning-effort high',
      agentEnv: {
        CODEX_PROFILE: 'captured',
        ORCA_PANE_KEY: 'wrong-pane',
        ORCA_TAB_ID: 'wrong-tab',
        ORCA_WORKTREE_ID: 'wrong-worktree',
        ORCA_WORKSPACE_ID: 'wrong-workspace'
      }
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--model changed' },
        agentDefaultEnv: { codex: { CODEX_PROFILE: 'changed' } }
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          launchConfig
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--model' 'gpt-5' '--reasoning-effort' 'high' 'resume' 'codex-session-1'",
        env: expect.objectContaining({
          CODEX_PROFILE: 'captured',
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(paneKey, launchConfig, {
      agentType: 'codex',
      launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)),
      tabId: 'tab-1',
      leafId: LEAF_1
    })
  })

  it('clears stale launch config when a pane consumes a non-agent startup command', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ startup: { command: 'echo plain-command' } }) as never
    )
    await flushAsyncTicks()

    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)
  })

  it('ignores a late exit from a transport that no longer owns the pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const oldTransport = createMockTransport('old-pty')
    const replacementTransport = createMockTransport('new-pty')
    transportFactoryQueue.push(oldTransport)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    deps.paneTransportsRef.current.set(pane.id, replacementTransport)

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    onPtyExit?.('old-pty')

    expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(1, null)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'old-pty')
    expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('old-pty')
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('clears launch config when an agent startup spawn produces no PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const launchConfig = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      ptyIdsByTabId: { 'tab-1': [] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    } as StoreState

    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        startup: {
          command: 'codex',
          launchConfig,
          launchToken: 'launch-token-1',
          launchAgent: 'codex'
        }
      }) as never
    )
    try {
      await flushAsyncTicks(20)
      await new Promise((resolve) => setTimeout(resolve, 70))

      expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(paneKey, launchConfig, {
        agentType: 'codex',
        launchToken: 'launch-token-1',
        tabId: 'tab-1',
        leafId: LEAF_1
      })
      expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)

      const registerOrder = mockStoreState.registerAgentLaunchConfig.mock.invocationCallOrder[0]
      const clearOrder = mockStoreState.clearAgentLaunchConfig.mock.invocationCallOrder[0]
      expect(registerOrder).toBeDefined()
      expect(clearOrder).toBeDefined()
      expect(registerOrder!).toBeLessThan(clearOrder!)
    } finally {
      binding.dispose()
    }
  })

  it('prefers live-entry launch config for pane cold restore when status survived PTY loss', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const launchConfig = {
      agentCommand: "codex '--model' 'gpt-5-mini'",
      agentArgs: '--model gpt-5-mini',
      agentEnv: {}
    }
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--model changed' }
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' }
        }
      },
      agentLaunchConfigByPaneKey: {
        [paneKey]: { launchConfig }
      },
      sleepingAgentSessionsByPaneKey: {}
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--model' 'gpt-5-mini' 'resume' 'codex-session-1'",
        env: expect.objectContaining({
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(paneKey, launchConfig, {
      agentType: 'codex',
      launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)),
      tabId: 'tab-1',
      leafId: LEAF_1
    })
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('ignores stale live launch config when cold restore identity lookup rejects it', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('fresh-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return {
          id: 'fresh-pty',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--model current' }
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' }
        }
      },
      agentLaunchConfigByPaneKey: {
        [paneKey]: {
          launchConfig: {
            agentCommand: "codex '--model' 'stale'",
            agentArgs: '--model stale',
            agentEnv: {}
          }
        }
      },
      getAgentLaunchConfigForStatusEntry: vi.fn(() => undefined),
      getAgentLaunchConfigForStatusMetadata: vi.fn(() => undefined),
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'older-codex-session' },
          prompt: 'older task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          launchConfig: {
            agentCommand: "codex '--model' 'sleeping-stale'",
            agentArgs: '--model sleeping-stale',
            agentEnv: { CODEX_PROFILE: 'sleeping-stale' }
          }
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(mockStoreState.getAgentLaunchConfigForStatusEntry).toHaveBeenCalledWith(
      expect.objectContaining({ paneKey, agentType: 'codex' })
    )
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'lost-pty',
        command: "codex '--model' 'current' 'resume' 'codex-session-1'"
      })
    )
    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(
      paneKey,
      expect.objectContaining({
        agentArgs: '--model current'
      }),
      expect.objectContaining({
        agentType: 'codex',
        tabId: 'tab-1',
        leafId: LEAF_1
      })
    )
  })

  it('shows the restored banner when a sleeping resume falls back to a fresh shell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const staleSessionId = 'wt-1@@stale-session'
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      if (opts.sessionId) {
        return undefined
      }
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('fresh-pty')
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_2)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: staleSessionId }]
      },
      ptyIdsByTabId: {
        'tab-1': [staleSessionId]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_2]: staleSessionId }
        }
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: staleSessionId }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(10)

    expect(transport.connect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: staleSessionId })
    )
    expect(transport.connect).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', staleSessionId)
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('--- session restored ---'),
      expect.any(Function)
    )
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2)
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
  })

  it('resumes a local sleeping pane in place when the restored PTY hint is missing', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const spawn = createDeferred<string>()
    const transport = createMockTransport()
    transport.connect.mockImplementation(() => spawn.promise)
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_2)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: null }]
      },
      ptyIdsByTabId: {
        'tab-1': []
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      },
      settings: {
        ...mockStoreState.settings,
        agentCmdOverrides: {}
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: {}
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(4)

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
        launchAgent: 'codex',
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
    expect(transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(
      paneKey,
      {
        agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      {
        agentType: 'codex',
        launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)),
        tabId: 'tab-1',
        leafId: LEAF_2
      }
    )
    expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()

    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    onPtySpawn?.('fresh-pty')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-pty')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-pty')
    expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()

    spawn.resolve('fresh-pty')
    await flushAsyncTicks(10)

    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(2)
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
  })

  it('keeps sleeping resume record when fresh cold-restore spawn fails', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const staleSessionId = 'wt-1@@stale-session'
    const transport = createMockTransport()
    transport.connect.mockResolvedValue(undefined)
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_2)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: staleSessionId }]
      },
      ptyIdsByTabId: {
        'tab-1': [staleSessionId]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_2]: staleSessionId }
        }
      },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: staleSessionId }
    })

    connectPanePty(createPane(2) as never, createManager(2) as never, deps as never)
    await flushAsyncTicks(20)

    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  it('does not write the restored banner through xterm bytes for sidebar-resumed startup commands', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-1')
    transportFactoryQueue.push(transport)
    const pane = createPane(1)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        startup: {
          command: "codex 'resume' 'codex-session-1'",
          showSessionRestoredBanner: true
        }
      }) as never
    )
    await flushAsyncTicks(10)
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
      | ((ptyId: string) => void)
      | undefined
    onPtySpawn?.('pty-1')
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('--- session restored ---'),
      expect.any(Function)
    )
    expect(createdTransportOptions[0]?.command).toBe("codex 'resume' 'codex-session-1'")
  })

  it('does not consume the sleeping record when daemon reattach returns a live snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: 'live-snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
  })

  it('does not resume the provider session when daemon reattach returns a live snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      if (sessionId) {
        return { id: sessionId, snapshot: 'live-snapshot' }
      }
      return null
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      agentStatusByPaneKey: {
        [paneKey]: {
          state: 'working',
          prompt: 'finish the task',
          agentType: 'codex',
          paneKey,
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          providerSession: { key: 'session_id', id: 'codex-session-1' }
        }
      }
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(pane.terminal.write).toHaveBeenCalledWith('live-snapshot', expect.any(Function))
    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('renders the reattach snapshot before live bytes delivered during the spawn reply', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return null
        }
        // Why: the real dispatcher drains post-snapshot bytes as soon as spawn IPC resolves, before connect() returns.
        callbacks?.onData?.('post-snapshot-live')
        return { id: sessionId, snapshot: 'authoritative-snapshot' }
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    const snapshotIndex = writes.indexOf('authoritative-snapshot')
    expect(snapshotIndex).toBeGreaterThanOrEqual(0)
    expect(writes).not.toContain('post-snapshot-live')
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(2)
    }
    await flushAsyncTicks(8)
    const liveIndex = writes.indexOf('post-snapshot-live')
    expect(liveIndex).toBeGreaterThan(snapshotIndex)
  })

  it('re-enforces follow intent after deferred reattach live output parses', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markTerminalFollowOutput } = await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return null
        }
        callbacks?.onData?.('post-snapshot-live')
        return { id: sessionId, snapshot: 'authoritative-snapshot' }
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.buffer.active.baseY = 100
    pane.terminal.buffer.active.viewportY = 100
    markTerminalFollowOutput(pane.terminal)
    const parseCallbacks: (() => void)[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      parseCallbacks.push(() => {
        if (data === 'post-snapshot-live') {
          pane.terminal.buffer.active.baseY = 200
          pane.terminal.buffer.active.viewportY = 100
        }
        callback?.()
      })
    })
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    for (let index = 0; index < 30; index += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
      if (parseCallbacks.length === 0 && index > 5) {
        break
      }
    }

    expect(pane.terminal.buffer.active.viewportY).toBe(200)
  })

  it('does not steal a newer user pin while deferred reattach output settles', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markTerminalFollowOutput, markTerminalPinnedViewport } =
      await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return null
        }
        callbacks?.onData?.('post-snapshot-live')
        return { id: sessionId, snapshot: 'authoritative-snapshot' }
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.buffer.active.baseY = 100
    pane.terminal.buffer.active.viewportY = 100
    markTerminalFollowOutput(pane.terminal)
    const parseCallbacks: { data: string; run: () => void }[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      parseCallbacks.push({
        data,
        run: () => {
          if (data === 'post-snapshot-live') {
            pane.terminal.buffer.active.baseY = 200
            pane.terminal.buffer.active.viewportY = 100
          }
          callback?.()
        }
      })
    })
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    for (let index = 0; index < 40; index += 1) {
      const pending = parseCallbacks.shift()
      pending?.run()
      await flushAsyncTicks(4)
      if (pending?.data === 'post-snapshot-live') {
        pane.terminal.buffer.active.viewportY = 150
        markTerminalPinnedViewport(pane.terminal)
      }
      if (parseCallbacks.length === 0 && index > 8) {
        break
      }
    }

    expect(pane.terminal.buffer.active.viewportY).toBe(150)
  })

  it('does not enforce a deferred viewport after the pane becomes hidden', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markTerminalFollowOutput } = await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return null
        }
        callbacks?.onData?.('post-snapshot-live')
        return { id: sessionId, snapshot: 'authoritative-snapshot' }
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    pane.terminal.buffer.active.baseY = 100
    pane.terminal.buffer.active.viewportY = 100
    markTerminalFollowOutput(pane.terminal)
    const parseCallbacks: { data: string; run: () => void }[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      parseCallbacks.push({
        data,
        run: () => {
          if (data === 'post-snapshot-live') {
            pane.terminal.buffer.active.baseY = 200
            pane.terminal.buffer.active.viewportY = 100
          }
          callback?.()
        }
      })
    })
    const deps = createDeps({
      isVisibleRef: { current: true },
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)
    for (let index = 0; index < 40; index += 1) {
      const pending = parseCallbacks.shift()
      pending?.run()
      await flushAsyncTicks(4)
      if (pending?.data === 'post-snapshot-live') {
        ;(deps.isVisibleRef as { current: boolean }).current = false
      }
      if (parseCallbacks.length === 0 && index > 8) {
        break
      }
    }

    expect(pane.terminal.buffer.active.viewportY).toBe(100)
  })

  it('does not fresh-spawn after a dead deferred session delivers its buffered exit', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transport.connect.mockImplementation(
      async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (!sessionId) {
          return 'unexpected-fresh-pty'
        }
        callbacks?.onData?.('dead-session-final-frame')
        return { id: sessionId, exitedBeforeAttach: true }
      }
    )
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
    })

    connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(writes).toContain('dead-session-final-frame')
    expect(deps.updateTabPtyId).not.toHaveBeenCalled()
  })

  // Why: Phase 6 deleted the hidden-skip grammar — every hidden chunk rides the background scheduler, none content-scanned.
  it('queues hidden PTY bytes on the background scheduler without per-chunk scanning', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    try {
      const hiddenChunks = [
        'plain hidden text\r\n',
        '\x1b[2J\x1b[Hcontrol redraw\r\n',
        '\x1b[2J\x1b[H╭ table 😀 ╮\r\n',
        '\x1b[?2026h| Sam Syntax | 😀 |\r\n\x1b[?2026l',
        '\x1b[?2026h\x1b[6n'
      ]
      for (const chunk of hiddenChunks) {
        capturedDataCallback.current?.(chunk)
      }

      // Background path defers writes; nothing is written synchronously.
      expect(pane.terminal.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(50)
      // The drain may coalesce queued chunks into one write — assert content.
      const written = pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
      for (const chunk of hiddenChunks) {
        expect(written).toContain(chunk)
      }
      // No model restore is latched for bounded hidden output.
      expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('hidden-delivery gate', () => {
    function enableMainAuthority(): void {
      mockStoreState.settings = {
        ...mockStoreState.settings,
        terminalMainSideEffectAuthority: true
      } as StoreState['settings']
    }

    function getSetHiddenRendererPtyMock(): ReturnType<typeof vi.fn> {
      return window.api.pty.setHiddenRendererPty as unknown as ReturnType<typeof vi.fn>
    }

    async function connectHiddenPane(deps: ReturnType<typeof createDeps>): Promise<{
      transport: MockTransport
      pane: ReturnType<typeof createPane>
      dataCallback: (
        data: string,
        meta?: { seq?: number; rawLength?: number; droppedOutput?: boolean }
      ) => void
      binding: { syncProcessTracking: () => void; dispose: () => void }
    }> {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current:
          | ((
              data: string,
              meta?: { seq?: number; rawLength?: number; droppedOutput?: boolean }
            ) => void)
          | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(pane as never, manager as never, deps as never) as {
        syncProcessTracking: () => void
        dispose: () => void
      }
      await flushAsyncTicks(6)
      expect(capturedDataCallback.current).not.toBeNull()
      return { transport, pane, dataCallback: capturedDataCallback.current!, binding }
    }

    it('marks the PTY hidden on hidden output and clears it before requesting restore on reveal', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { pane, dataCallback } = await connectHiddenPane(deps)
      const setHiddenRendererPty = getSetHiddenRendererPtyMock()
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'model snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })
      pane.terminal.options.scrollback = 50_000

      dataCallback('hidden output\r\n', { seq: 16, rawLength: 16 })
      expect(setHiddenRendererPty).toHaveBeenCalledWith('pty-id', true)

      // Why: with the skip grammar gone, gated drops latch the restore via main's out-of-band marker, not a renderer content scan.
      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 64 })

      // Reveal rides the visible-resume backlog recovery hook.
      ;(deps.isVisibleRef as { current: boolean }).current = true
      const { requestTerminalBacklogRecovery } =
        await import('@/lib/pane-manager/pane-terminal-output-scheduler')
      requestTerminalBacklogRecovery(pane.terminal as never)
      await flushAsyncTicks(20)

      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', false)
      expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 50_000 })
      // The unhide IPC must precede the snapshot request (seq-guard contract).
      const unhideOrder = setHiddenRendererPty.mock.invocationCallOrder.at(-1)!
      const snapshotOrder = getMainBufferSnapshot.mock.invocationCallOrder[0]!
      expect(unhideOrder).toBeLessThan(snapshotOrder)
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining('model snapshot'),
        expect.any(Function)
      )
    })

    it('holds post-snapshot live bytes until a hidden restore can fit the destination grid', async () => {
      enableMainAuthority()
      const { safeFit } = await import('@/lib/pane-manager/pane-tree-ops')
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { pane, transport, dataCallback } = await connectHiddenPane(deps)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'source-grid hidden snapshot\r\n',
        cols: 80,
        rows: 24,
        seq: 64
      })
      pane.fitAddon.proposeDimensions = vi.fn(() => undefined) as never
      transport.resize.mockClear()

      dataCallback('hidden output\r\n', { seq: 16, rawLength: 16 })
      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 64 })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      const { requestTerminalBacklogRecovery } =
        await import('@/lib/pane-manager/pane-terminal-output-scheduler')
      requestTerminalBacklogRecovery(pane.terminal as never)
      await flushAsyncTicks(20)

      expect(transport.resize).not.toHaveBeenCalled()
      dataCallback('live-after-hidden', { seq: 81, rawLength: 17 })
      await flushAsyncTicks(6)
      expect(pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')).not.toContain(
        'live-after-hidden'
      )

      pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 })) as never
      safeFit(pane as never)
      await flushAsyncTicks(20)

      expect(transport.resize).toHaveBeenCalledWith(120, 40)
      expect(pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')).toContain(
        'live-after-hidden'
      )
    })

    it('kicks pane recovery when reveal finds the write pipeline certified dead', async () => {
      // 2026-07-13 fossil-pane incident: bytes drop while hidden, pipeline certified dead, cert recovery empty — reveal must re-kick it.
      enableMainAuthority()
      const remountTerminalTabForRecovery = vi.fn<(tabId: string) => boolean>(() => true)
      mockStoreState = { ...mockStoreState, remountTerminalTabForRecovery } as StoreState
      const { _resetTerminalPaneRecoveryForTests } = await import('./terminal-pane-recovery')
      _resetTerminalPaneRecoveryForTests()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { pane, dataCallback } = await connectHiddenPane(deps)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'model snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })

      dataCallback('hidden output\r\n', { seq: 16, rawLength: 16 })

      // Pipeline dies while hidden; certification-time recovery finds no remountable tab (budget unconsumed, no retry timer).
      remountTerminalTabForRecovery.mockReturnValueOnce(false)
      const ackCredit = vi.fn()
      const { writeTerminalOutput } =
        await import('@/lib/pane-manager/pane-terminal-output-scheduler')
      writeTerminalOutput(pane.terminal, 'queued before certification', {
        foreground: false,
        ackCredit
      })
      const { notifyUndeliverableWrite } =
        await import('@/lib/pane-manager/terminal-write-pipeline-health')
      notifyUndeliverableWrite(pane.terminal, 'write-stalled')
      expect(ackCredit).toHaveBeenCalledTimes(1)
      await flushAsyncTicks(4)
      expect(remountTerminalTabForRecovery).toHaveBeenCalledTimes(1)

      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 64 })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      const { requestTerminalBacklogRecovery } =
        await import('@/lib/pane-manager/pane-terminal-output-scheduler')
      requestTerminalBacklogRecovery(pane.terminal as never)
      await flushAsyncTicks(20)

      // Restore stays skipped (a dead pipeline can't parse the snapshot), but recovery got exactly one re-kick.
      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
      expect(remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
      expect(remountTerminalTabForRecovery).toHaveBeenLastCalledWith('tab-1')

      // Latched per xterm instance: repeat restore attempts do not spam.
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 96 })
      await flushAsyncTicks(4)
      expect(remountTerminalTabForRecovery).toHaveBeenCalledTimes(2)
      _resetTerminalPaneRecoveryForTests()
    })

    it('clears the hidden bit on visibility flips through syncProcessTracking', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { dataCallback, binding } = await connectHiddenPane(deps)
      const setHiddenRendererPty = getSetHiddenRendererPtyMock()

      dataCallback('hidden output\r\n')
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', true)
      ;(deps.isVisibleRef as { current: boolean }).current = true
      binding.syncProcessTracking()
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', false)

      // Hiding again re-marks through the same lifecycle hook.
      ;(deps.isVisibleRef as { current: boolean }).current = false
      binding.syncProcessTracking()
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', true)
    })

    it('marks hidden codex panes immediately — no startup renderer-query window remains', async () => {
      enableMainAuthority()
      const deps = createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      })
      const { transport, dataCallback } = await connectHiddenPane(deps)
      const setHiddenRendererPty = getSetHiddenRendererPtyMock()
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const factsHandler = await import('./terminal-side-effect-facts-handler')

      // Why: Phase 6 deleted the 10s codex window — codex startups gate like any hidden pane; main answers their startup probes.
      dataCallback('startup probe output\r\n')
      expect(setHiddenRendererPty).toHaveBeenCalledWith('pty-id', true)

      // The fact stays the sole 2031 responder for gate-managed PTYs.
      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 8,
        facts: [{ kind: '2031-subscribe' }]
      })
      expect(transport.sendInput).toHaveBeenCalledTimes(1)
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[?997;1n')
    })

    it('latches model restore from the out-of-band marker and restores on reveal', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { pane, dataCallback } = await connectHiddenPane(deps)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'dropped bytes snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })
      // Why: the marker subscription is keyed by the live PTY id — the byte path latches it on the first hidden chunk.
      dataCallback('pre-drop output\r\n', { seq: 16, rawLength: 17 })
      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')

      // Main dropped gated bytes and signalled it out-of-band.
      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'hidden-drop', markerSeq: 64 })
      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
      ;(deps.isVisibleRef as { current: boolean }).current = true
      const { requestTerminalBacklogRecovery } =
        await import('@/lib/pane-manager/pane-terminal-output-scheduler')
      requestTerminalBacklogRecovery(pane.terminal as never)
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining('dropped bytes snapshot'),
        expect.any(Function)
      )
    })

    it('answers each 2031-subscribe fact exactly once, before any hidden mark exists', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { transport } = await connectHiddenPane(deps)
      // Simulate spawn completion so the pane registers its fact consumer (mock transport never calls onPtySpawn).
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const factsHandler = await import('./terminal-side-effect-facts-handler')

      // Why: the fact can outrun the hidden mark (codex startup race) and must still reply — ownership is structural, not mark-dependent.
      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 12,
        facts: [{ kind: '2031-subscribe' }]
      })
      expect(transport.sendInput).toHaveBeenCalledTimes(1)
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[?997;1n')

      // Why: a visible gated pane still answers via the fact — the lifecycle suppresses xterm's CSI reply for gate-managed panes.
      ;(deps.isVisibleRef as { current: boolean }).current = true
      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 24,
        facts: [{ kind: '2031-subscribe' }]
      })
      expect(transport.sendInput).toHaveBeenCalledTimes(2)
      expect(transport.sendInput).toHaveBeenLastCalledWith('\x1b[?997;1n')
    })

    it('registers the fact-answered 2031 subscription for later theme flips', async () => {
      enableMainAuthority()
      const recordPaneMode2031Subscription = vi.fn()
      const deps = createDeps({
        isVisibleRef: { current: false },
        recordPaneMode2031Subscription
      })
      const { transport } = await connectHiddenPane(deps)
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const factsHandler = await import('./terminal-side-effect-facts-handler')

      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 12,
        facts: [{ kind: '2031-subscribe' }]
      })

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[?997;1n')
      // Why: without the registry write, maybePushMode2031Flip won't push CSI 997 after a theme change, so the TUI keeps a stale theme.
      expect(recordPaneMode2031Subscription).toHaveBeenCalledWith(1, 'dark')
    })

    it('reports the gate-managed predicate on the binding for the xterm 2031 observer', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { binding } = await connectHiddenPane(deps)
      const bindingWithPredicate = binding as typeof binding & {
        isHiddenDeliveryGateManagedPty: () => boolean
      }
      expect(bindingWithPredicate.isHiddenDeliveryGateManagedPty()).toBe(true)
    })

    it('declares hidden-at-spawn on connect for hidden panes', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { transport } = await connectHiddenPane(deps)
      // Why: mark the PTY hidden before its first byte, closing the spawn-time DA1-loss window where neither side replied.
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ initiallyHidden: true })
      )
    })

    it('keeps visible spawns undeclared (visible spawn unchanged)', async () => {
      enableMainAuthority()
      const deps = createDeps()
      const { transport } = await connectHiddenPane(deps)
      expect(transport.connect.mock.calls[0]![0]).not.toHaveProperty('initiallyHidden')
    })

    it('declares hidden-at-spawn for hidden codex panes too', async () => {
      enableMainAuthority()
      const deps = createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      })
      const { transport } = await connectHiddenPane(deps)
      // Why: the 10s codex startup window is gone — codex spawns are main-owned from byte zero (main pin: pty.test.ts DA1-from-model).
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ initiallyHidden: true })
      )
    })

    it('does not gate or fact-reply when the hidden-delivery kill switch is off', async () => {
      enableMainAuthority()
      mockStoreState.settings = {
        ...mockStoreState.settings,
        terminalHiddenDeliveryGate: false
      } as StoreState['settings']
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { transport, dataCallback, binding } = await connectHiddenPane(deps)
      // Why: the lifecycle's xterm CSI observer consults this predicate — kill switch off keeps the legacy xterm reply path.
      expect(
        (
          binding as typeof binding & { isHiddenDeliveryGateManagedPty: () => boolean }
        ).isHiddenDeliveryGateManagedPty()
      ).toBe(false)
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const setHiddenRendererPty = getSetHiddenRendererPtyMock()

      dataCallback('hidden output\r\n')
      expect(setHiddenRendererPty).not.toHaveBeenCalled()

      // Why: gate off keeps the byte-scan responder authoritative — the fact must not produce a second reply.
      const factsHandler = await import('./terminal-side-effect-facts-handler')
      factsHandler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-id',
        seq: 12,
        facts: [{ kind: '2031-subscribe' }]
      })
      expect(transport.sendInput).not.toHaveBeenCalled()
    })

    it('clears a marked-hidden PTY on dispose so a remount is never gated', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: false } })
      const { dataCallback, binding } = await connectHiddenPane(deps)
      const setHiddenRendererPty = getSetHiddenRendererPtyMock()

      dataCallback('hidden output\r\n')
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', true)

      binding.dispose()
      expect(setHiddenRendererPty).toHaveBeenLastCalledWith('pty-id', false)
    })

    it('never treats a live chunk that strips to empty as a restore marker', async () => {
      // Why: an all-OSC-9999 chunk arrives as '' after stripping; only pty:modelRestoreNeeded may trigger a restore, not the empty byte path.
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: true } })
      const { dataCallback } = await connectHiddenPane(deps)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >

      dataCallback('', { seq: 32, rawLength: 24 })
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    })

    it('gates marker re-arms during an in-flight foreground restore and repaints once after', async () => {
      enableMainAuthority()
      const deps = createDeps({ isVisibleRef: { current: true } })
      await connectHiddenPane(deps)
      const transportOptions = createdTransportOptions.at(-1) as {
        onPtySpawn?: (ptyId: string) => void
      }
      transportOptions.onPtySpawn?.('pty-id')
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      const firstSnapshot = createDeferred<{
        data: string
        cols: number
        rows: number
        seq: number
      }>()
      getMainBufferSnapshot
        .mockReturnValueOnce(firstSnapshot.promise)
        .mockResolvedValue({ data: 'post-flood repaint\r\n', cols: 100, rows: 30, seq: 96 })
      const { _dispatchPtyModelRestoreNeededForTest } = await import('./pty-model-restore-channel')

      _dispatchPtyModelRestoreNeededForTest({ id: 'pty-id', reason: 'pending-cap', markerSeq: 64 })
      await flushAsyncTicks(4)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

      try {
        // Why (rc.7.perf): a second drop marker while the first snapshot serializes is self-backpressure; must NOT re-fetch.
        vi.useFakeTimers()
        _dispatchPtyModelRestoreNeededForTest({
          id: 'pty-id',
          reason: 'pending-cap',
          markerSeq: 80
        })
        firstSnapshot.resolve({ data: 'first snapshot\r\n', cols: 100, rows: 30, seq: 64 })
        await flushAsyncTicks(20)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

        // Flood quiet: suppression window elapses and exactly ONE deferred repaint heals the dropped gap.
        vi.advanceTimersByTime(2_100)
        await flushAsyncTicks(20)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    describe('foreground flood restore feedback loop (rc.7.perf)', () => {
      function writtenFloodData(pane: ReturnType<typeof createPane>): string {
        return pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
      }

      async function startInFlightRestore(): Promise<{
        pane: ReturnType<typeof createPane>
        transport: MockTransport
        dataCallback: (
          data: string,
          meta?: { seq?: number; rawLength?: number; droppedOutput?: boolean }
        ) => void
        getMainBufferSnapshot: ReturnType<typeof vi.fn>
        resolveFirstSnapshot: (snapshot: {
          data: string
          cols: number
          rows: number
          seq: number
        }) => void
      }> {
        enableMainAuthority()
        const deps = createDeps({ isVisibleRef: { current: true } })
        const { pane, transport, dataCallback } = await connectHiddenPane(deps)
        const transportOptions = createdTransportOptions.at(-1) as {
          onPtySpawn?: (ptyId: string) => void
        }
        transportOptions.onPtySpawn?.('pty-id')
        const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
          typeof vi.fn
        >
        const firstSnapshot = createDeferred<{
          data: string
          cols: number
          rows: number
          seq: number
        }>()
        getMainBufferSnapshot
          .mockReturnValueOnce(firstSnapshot.promise)
          .mockResolvedValue({ data: 'repaint snapshot\r\n', cols: 100, rows: 30, seq: 5_000_000 })
        const { _dispatchPtyModelRestoreNeededForTest } =
          await import('./pty-model-restore-channel')
        _dispatchPtyModelRestoreNeededForTest({
          id: 'pty-id',
          reason: 'pending-cap',
          markerSeq: 64
        })
        await flushAsyncTicks(4)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
        return {
          pane,
          transport,
          dataCallback,
          getMainBufferSnapshot,
          resolveFirstSnapshot: (snapshot) => firstSnapshot.resolve(snapshot)
        }
      }

      it('abandons the restore on queue overflow, writes the stream through, and repaints once', async () => {
        const { pane, dataCallback, getMainBufferSnapshot, resolveFirstSnapshot } =
          await startInFlightRestore()
        const { markTerminalPinnedViewport } =
          await import('@/lib/pane-manager/terminal-scroll-intent')
        const parseCallbacks: (() => void)[] = []
        pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
          if (callback) {
            parseCallbacks.push(callback)
          }
        })
        pane.terminal.buffer.active.viewportY = 42
        pane.terminal.buffer.active.baseY = 100
        markTerminalPinnedViewport(pane.terminal)

        // Flood while the snapshot is in flight: overflows the 512KB restore queue.
        dataCallback('f'.repeat(300 * 1024), { seq: 300 * 1024 + 64, rawLength: 300 * 1024 })
        dataCallback('g'.repeat(300 * 1024), { seq: 600 * 1024 + 64, rawLength: 300 * 1024 })

        try {
          vi.useFakeTimers()
          resolveFirstSnapshot({ data: 'flood snapshot\r\n', cols: 100, rows: 30, seq: 64 })
          await flushAsyncTicks(20)

          // Cut 1: the overflow abandons the restore instead of re-fetching.
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
          pane.terminal.buffer.active.viewportY = 200
          pane.terminal.buffer.active.baseY = 200
          for (const callback of parseCallbacks.splice(0)) {
            callback()
          }
          // The post-replay fit is part of the transaction now; let its promise settle before asserting.
          await flushAsyncTicks(20)
          expect(pane.terminal.scrollToLine).toHaveBeenLastCalledWith(142)

          // Cut 2: drop sentinels and seq-gap chunks during the flood window must not re-arm restores — post-gap bytes write through.
          dataCallback('', { droppedOutput: true })
          dataCallback('AFTER-FLOOD', { seq: 700 * 1024, rawLength: 11 })
          await flushAsyncTicks(8)
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
          expect(writtenFloodData(pane)).toContain('AFTER-FLOOD')

          // After the flood goes quiet: exactly ONE deferred repaint.
          vi.advanceTimersByTime(2_100)
          await flushAsyncTicks(20)
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
          vi.advanceTimersByTime(5_000)
          await flushAsyncTicks(20)
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        } finally {
          vi.useRealTimers()
        }
      })

      it('sends salvaged queries immediately from an overflowing restore queue', async () => {
        const { pane, transport, dataCallback } = await startInFlightRestore()

        // Queue 400KB, then overflow with color/CPR/DA probes — the discarded probes need direct replies before their read windows close.
        dataCallback('a'.repeat(400 * 1024), { seq: 400 * 1024, rawLength: 400 * 1024 })
        const queries = '\x1b]11;?\x1b\\\x1b[6n\x1b[c'
        dataCallback(`${'b'.repeat(200 * 1024)}${queries}`, {
          seq: 600 * 1024 + queries.length,
          rawLength: 200 * 1024 + queries.length
        })
        await flushAsyncTicks(8)

        const replies = transport.sendInputImmediate.mock.calls.map((call) => String(call[0]))
        expect(replies.some((reply) => reply.startsWith('\x1b]11;rgb:'))).toBe(true)
        // oxlint-disable-next-line no-control-regex -- the ESC byte IS the payload: this matches the CPR reply
        expect(replies.some((reply) => /^\u001b\[\d+;\d+R$/.test(reply))).toBe(true)
        expect(replies).toContain(DEFAULT_DA1_RESPONSE)
        const written = writtenFloodData(pane)
        expect(written).not.toContain('aaaa')
        expect(written).not.toContain('bbbb')
      })

      it('keeps the hidden-pane drop sentinel arming a reveal restore (gate unchanged)', async () => {
        enableMainAuthority()
        const isVisibleRef = { current: false }
        const deps = createDeps({ isVisibleRef })
        const { pane, dataCallback } = await connectHiddenPane(deps)
        const transportOptions = createdTransportOptions.at(-1) as {
          onPtySpawn?: (ptyId: string) => void
        }
        transportOptions.onPtySpawn?.('pty-id')
        const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
          typeof vi.fn
        >
        getMainBufferSnapshot.mockResolvedValue({
          data: 'hidden reveal snapshot\r\n',
          cols: 100,
          rows: 30,
          seq: 64
        })

        // Hidden pane: the sentinel latches restore-needed but must not fetch.
        dataCallback('', { droppedOutput: true })
        await flushAsyncTicks(8)
        expect(getMainBufferSnapshot).not.toHaveBeenCalled()

        // Reveal: the latched restore fetches exactly one snapshot.
        isVisibleRef.current = true
        const { requestTerminalBacklogRecovery } =
          await import('@/lib/pane-manager/pane-terminal-output-scheduler')
        requestTerminalBacklogRecovery(pane.terminal as never)
        await flushAsyncTicks(20)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
        expect(writtenFloodData(pane)).toContain('hidden reveal snapshot')
      })
    })

    describe('post-restore backlog reconciliation', () => {
      async function restoreVisiblePaneToBaseline(): Promise<{
        pane: ReturnType<typeof createPane>
        dataCallback: (data: string, meta?: { seq?: number; rawLength?: number }) => void
        getMainBufferSnapshot: ReturnType<typeof vi.fn>
      }> {
        enableMainAuthority()
        const deps = createDeps({ isVisibleRef: { current: true } })
        const { pane, dataCallback } = await connectHiddenPane(deps)
        const transportOptions = createdTransportOptions.at(-1) as {
          onPtySpawn?: (ptyId: string) => void
        }
        transportOptions.onPtySpawn?.('pty-id')
        const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
          typeof vi.fn
        >
        getMainBufferSnapshot.mockResolvedValue({
          data: 'restored snapshot\r\n',
          cols: 100,
          rows: 30,
          seq: 64
        })
        const { _dispatchPtyModelRestoreNeededForTest } =
          await import('./pty-model-restore-channel')
        _dispatchPtyModelRestoreNeededForTest({
          id: 'pty-id',
          reason: 'pending-cap',
          markerSeq: 64
        })
        await flushAsyncTicks(20)
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
        expect(pane.terminal.write).toHaveBeenCalledWith(
          expect.stringContaining('restored snapshot'),
          expect.any(Function)
        )
        pane.terminal.write.mockClear()
        return { pane, dataCallback, getMainBufferSnapshot }
      }

      function writtenData(pane: ReturnType<typeof createPane>): string {
        return pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
      }

      it('drops backlog chunks the restored snapshot already covers', async () => {
        const { pane, dataCallback } = await restoreVisiblePaneToBaseline()

        // Whole chunk at or before the baseline seq: duplicate, never written.
        dataCallback('OLD-DUPLICATE', { seq: 60, rawLength: 13 })
        await flushAsyncTicks(8)
        expect(writtenData(pane)).not.toContain('OLD-DUPLICATE')

        // Contiguous post-baseline chunk flows through normally.
        dataCallback('NEW', { seq: 67, rawLength: 3 })
        await flushAsyncTicks(8)
        expect(writtenData(pane)).toContain('NEW')
      })

      it('slices a partial overlap when raw and clean lengths match', async () => {
        const { pane, dataCallback } = await restoreVisiblePaneToBaseline()

        // start seq 61 < baseline 64 < end seq 67 — only the last 3 chars are new.
        dataCallback('ABCDEF', { seq: 67, rawLength: 6 })
        await flushAsyncTicks(8)

        const written = writtenData(pane)
        expect(written).toContain('DEF')
        expect(written).not.toContain('ABC')
      })

      it('forces a fresh snapshot for an overlap whose offsets cannot be mapped', async () => {
        const { pane, dataCallback, getMainBufferSnapshot } = await restoreVisiblePaneToBaseline()
        getMainBufferSnapshot.mockResolvedValue({
          data: 'second snapshot\r\n',
          cols: 100,
          rows: 30,
          seq: 80
        })

        // rawLength (6) !== data.length (4): OSC stripping makes the slice offset unmappable — restore from a fresh snapshot instead.
        dataCallback('ABCD', { seq: 67, rawLength: 6 })
        await flushAsyncTicks(20)

        expect(writtenData(pane)).not.toContain('ABCD')
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        expect(writtenData(pane)).toContain('second snapshot')
      })

      it('detects a seq gap after restore and forces another restore', async () => {
        const { pane, dataCallback, getMainBufferSnapshot } = await restoreVisiblePaneToBaseline()
        getMainBufferSnapshot.mockResolvedValue({
          data: 'gap-heal snapshot\r\n',
          cols: 100,
          rows: 30,
          seq: 120
        })

        // Why: a chunk starting past the continuity point means main trimmed bytes after the overflow marker — only the model snapshot can heal the gap.
        dataCallback('AFTER-GAP', { seq: 96, rawLength: 9 })
        await flushAsyncTicks(20)

        expect(writtenData(pane)).not.toContain('AFTER-GAP')
        expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
        expect(writtenData(pane)).toContain('gap-heal snapshot')
      })

      it('writes genuinely-new live output whose seq sits below an empty-backlog baseline', async () => {
        // E2E twin: a live chunk's seq sits below main's cumulative baseline, but with an empty pending queue main can never re-deliver — so it must write, not drop.
        enableMainAuthority()
        const isVisibleRef = { current: true }
        const deps = createDeps({ isVisibleRef })
        const { pane, dataCallback } = await connectHiddenPane(deps)
        const transportOptions = createdTransportOptions.at(-1) as {
          onPtySpawn?: (ptyId: string) => void
        }
        transportOptions.onPtySpawn?.('pty-id')
        const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
          typeof vi.fn
        >
        // Visible prompt echo metered in main's cumulative seq domain.
        dataCallback('$ node frame-script.mjs\r\n', { seq: 2_315, rawLength: 25 })
        // Pane hides mid-stream; main drops the hidden frame and marks restore.
        isVisibleRef.current = false
        const { _dispatchPtyModelRestoreNeededForTest } =
          await import('./pty-model-restore-channel')
        _dispatchPtyModelRestoreNeededForTest({
          id: 'pty-id',
          reason: 'hidden-drop',
          markerSeq: 2_472
        })
        // Reveal: the snapshot covers everything ingested; pending queue empty (pendingDeliveryStartSeq === seq).
        getMainBufferSnapshot.mockResolvedValue({
          data: 'LOW_RISK_RESTORE_FRAME_40\r\n',
          cols: 100,
          rows: 30,
          seq: 2_472,
          pendingDeliveryStartSeq: 2_472
        })
        isVisibleRef.current = true
        const { requestTerminalBacklogRecovery } =
          await import('@/lib/pane-manager/pane-terminal-output-scheduler')
        requestTerminalBacklogRecovery(pane.terminal as never)
        await flushAsyncTicks(20)
        expect(writtenData(pane)).toContain('LOW_RISK_RESTORE_FRAME_40')
        pane.terminal.write.mockClear()

        // Newer live frame injected with a seq domain unrelated to main's counter (e2e __terminalPtyDataInjection twin).
        dataCallback('LOW_RISK_RESTORE_FRAME_41\r\n', { seq: 315, rawLength: 27 })
        await flushAsyncTicks(8)
        expect(writtenData(pane)).toContain('LOW_RISK_RESTORE_FRAME_41')

        // The retired baseline keeps subsequent low-seq live chunks flowing.
        dataCallback('progress=041\r\n', { seq: 329, rawLength: 14 })
        await flushAsyncTicks(8)
        expect(writtenData(pane)).toContain('progress=041')
      })

      it('keeps suppressing backlog duplicates inside the reported pending window', async () => {
        const { pane, dataCallback, getMainBufferSnapshot } = await restoreVisiblePaneToBaseline()
        getMainBufferSnapshot.mockResolvedValue({
          data: 'windowed snapshot\r\n',
          cols: 100,
          rows: 30,
          seq: 96,
          pendingDeliveryStartSeq: 80
        })
        const { _dispatchPtyModelRestoreNeededForTest } =
          await import('./pty-model-restore-channel')
        _dispatchPtyModelRestoreNeededForTest({
          id: 'pty-id',
          reason: 'pending-cap',
          markerSeq: 96
        })
        await flushAsyncTicks(20)
        expect(writtenData(pane)).toContain('windowed snapshot')
        pane.terminal.write.mockClear()

        // Inside the pending window (80, 96]: a draining backlog duplicate.
        dataCallback('IN-WINDOW-DUP-16', { seq: 96, rawLength: 16 })
        await flushAsyncTicks(8)
        expect(writtenData(pane)).not.toContain('IN-WINDOW-DUP-16')

        // Past the baseline: genuinely-new live output still flows.
        dataCallback('PAST-BASELINE', { seq: 109, rawLength: 13 })
        await flushAsyncTicks(8)
        expect(writtenData(pane)).toContain('PAST-BASELINE')

        // Below the pending window (≤ 80): main can never re-send these seqs, so this foreign seq domain is written, never dropped.
        dataCallback('BELOW-WINDOW', { seq: 60, rawLength: 12 })
        await flushAsyncTicks(8)
        expect(writtenData(pane)).toContain('BELOW-WINDOW')
      })
    })
  })

  it('schedules WebGL atlas recovery after hidden synchronized output parses', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: false }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      const startChunk = '\x1b[?2026h'
      const plainRowChunk = '| hidden Claude row |\r\n'
      const endChunk = '\x1b[?2026l'

      capturedDataCallback.current?.(startChunk)
      capturedDataCallback.current?.(plainRowChunk)
      capturedDataCallback.current?.(endChunk)

      expect(writes).toEqual([])
      vi.advanceTimersByTime(50)

      expect(writes).toEqual([`${startChunk}${plainRowChunk}${endChunk}`])
      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()

      parseCallbacks[0]?.()

      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recognizes hidden synchronized output markers split across PTY chunks', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: false }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('\x1b[?202')
      capturedDataCallback.current?.('6hbody row\r\n')
      capturedDataCallback.current?.('tail\x1b[?20')
      capturedDataCallback.current?.('26l')

      vi.advanceTimersByTime(50)

      expect(writes.join('')).toBe('\x1b[?2026hbody row\r\ntail\x1b[?2026l')
      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()

      parseCallbacks[0]?.()

      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not schedule hidden atlas recovery for ordinary rich text or metadata output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: false }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('plain hidden emoji 😀 and CJK 没改什么\r\n')
      capturedDataCallback.current?.('\x1b[48;2;52;52;52mcolored shell text\x1b[0m\r\n')
      capturedDataCallback.current?.('\x1b]0;hidden title\x07\x1b]133;A\x07')

      vi.advanceTimersByTime(50)
      for (const callback of parseCallbacks) {
        callback()
      }

      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('schedules hidden atlas recovery for high-confidence TUI redraw controls', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: false }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('\x1b[2J\x1b[Hredrawn hidden table\x1b[K')

      vi.advanceTimersByTime(50)
      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()

      parseCallbacks[0]?.()

      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('advances hidden rewrite state when synchronized output already requests recovery', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef: { current: false }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('prompt rewrite\r')
      vi.advanceTimersByTime(50)
      expect(writes).toEqual(['prompt rewrite\r'])
      parseCallbacks.shift()?.()
      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()

      capturedDataCallback.current?.('\x1b[?2026hredraw frame\x1b[?2026l')
      vi.advanceTimersByTime(50)
      expect(writes).toEqual(['prompt rewrite\r', '\x1b[?2026hredraw frame\x1b[?2026l'])
      parseCallbacks.shift()?.()
      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
      scheduleTerminalWebglAtlasRecovery.mockClear()

      capturedDataCallback.current?.('plain after frame')
      vi.advanceTimersByTime(50)
      parseCallbacks.shift()?.()

      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets hidden synchronized state when hidden renderer output is skipped', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { background?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const isVisibleRef = { current: false }

    connectPanePty(
      pane as never,
      createManager(1) as never,
      createDeps({
        isVisibleRef
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('\x1b[?2026h')
      vi.advanceTimersByTime(50)
      parseCallbacks.shift()?.()
      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
      scheduleTerminalWebglAtlasRecovery.mockClear()
      writes.length = 0

      isVisibleRef.current = true
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
      capturedDataCallback.current?.('\x1b[?2026l', { background: true })
      expect(writes).toEqual([])

      isVisibleRef.current = false
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'normal'
      capturedDataCallback.current?.('plain after skipped close\r\n')
      vi.advanceTimersByTime(50)
      parseCallbacks.shift()?.()

      expect(writes).toEqual(['plain after skipped close\r\n'])
      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues visible split-pane PTY bytes when the pane is not active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isActiveRef: { current: false },
      isVisibleRef: { current: true }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    const redraw = '\x1b[2J\x1b[Hvisible split output\r\n'
    capturedDataCallback.current?.(redraw)

    expect(pane.terminal.write).not.toHaveBeenCalledWith(redraw, expect.any(Function))
    vi.advanceTimersByTime(0)
    expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
  })

  it('queues visible ANSI redraws when only another split pane is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = {
      ...createManager(2),
      getActivePane: vi.fn(() => ({ id: 2 }))
    }
    const deps = createDeps({
      isActiveRef: { current: true },
      isVisibleRef: { current: true }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    const redraw = '\x1b[2J\x1b[Hvisible inactive split output\r\n'
    capturedDataCallback.current?.(redraw)

    expect(pane.terminal.write).not.toHaveBeenCalledWith(redraw, expect.any(Function))
    vi.advanceTimersByTime(0)
    expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
  })

  it('routes visible pane PTY bytes through the background scheduler when the document is hidden', async () => {
    ;(globalThis as { document?: Pick<Document, 'visibilityState'> }).document = {
      visibilityState: 'hidden'
    }
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isActiveRef: { current: true },
      isVisibleRef: { current: true }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    capturedDataCallback.current?.('backgrounded document output\r\n')

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'backgrounded document output\r\n',
      expect.any(Function)
    )

    vi.advanceTimersByTime(50)
    expect(pane.terminal.write).toHaveBeenCalledWith('backgrounded document output\r\n')
  })

  it('keeps hidden Codex telemetry startup output parsing briefly', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: {
          command: 'wrapped-agent',
          telemetry: {
            agent_kind: 'codex',
            launch_source: 'tab_bar_quick_launch',
            request_kind: 'new'
          }
        }
      }) as never
    )
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b]11;?\x1b\\startup frame\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden Grok telemetry startup output parsing briefly', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: {
          command: 'wrapped-agent',
          telemetry: {
            agent_kind: 'grok',
            launch_source: 'tab_bar_quick_launch',
            request_kind: 'new'
          }
        }
      }) as never
    )
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b]11;?\x1b\\startup frame\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden bare Codex startup commands parsing briefly', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b]11;?\x1b\\startup frame\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden bare Grok startup commands parsing briefly', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: '/Users/me/.grok/bin/grok --permission-mode bypassPermissions' }
      }) as never
    )
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('\x1b]11;?\x1b\\startup frame\r\n')

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b]11;?\x1b\\startup frame\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('skips arbitrary hidden startup output parsing', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'printf noisy startup' }
      }) as never
    )
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()

    capturedDataCallback.current?.('hidden startup output\r\n')

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'hidden startup output\r\n',
      expect.any(Function)
    )

    binding.dispose()
  })

  it('writes mode 2031 through hidden xterm instead of side-channel answering it', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: { ...mockStoreState.settings, theme: 'light' }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.('\x1b[?2031h')
      vi.advanceTimersByTime(50)

      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[?2031h')
    } finally {
      vi.useRealTimers()
    }

    binding.dispose()
  })

  it('answers hidden Codex mode 2031 subscribes split across becoming visible', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      settings: { ...mockStoreState.settings, theme: 'light' }
    }

    const isVisibleRef = { current: false }
    const paneMode2031Ref = { current: new Map<number, boolean>() }
    const paneLastThemeModeRef = { current: new Map<number, 'dark' | 'light'>() }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        paneMode2031Ref,
        paneLastThemeModeRef,
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[?20')
    isVisibleRef.current = true
    capturedDataCallback.current?.('31h')

    expect(transport.sendInputImmediate).toHaveBeenCalledWith('\x1b[?997;2n')
    expect(paneMode2031Ref.current.get(1)).toBe(true)
    expect(paneLastThemeModeRef.current.get(1)).toBe('light')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('31h', expect.any(Function))

    binding.dispose()
  })

  it('does not keep mode 2031 subscribed when a skipped hidden chunk unsubscribes last', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const paneMode2031Ref = { current: new Map<number, boolean>() }
    const paneLastThemeModeRef = { current: new Map<number, 'dark' | 'light'>() }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        paneMode2031Ref,
        paneLastThemeModeRef,
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[?2031h\x1b[?2031l')

    expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
    expect(paneMode2031Ref.current.has(1)).toBe(false)
    expect(paneLastThemeModeRef.current.has(1)).toBe(false)

    binding.dispose()
  })

  it('keeps hidden Codex redraw floods off the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      const hiddenCodexRedraw = `\x1b[?2026h\x1b[2J\x1b[H${'codex redraw '.repeat(8_000)}`
      capturedDataCallback.current?.(hiddenCodexRedraw)
      vi.advanceTimersByTime(50)

      expect(pane.terminal.write).not.toHaveBeenCalledWith(hiddenCodexRedraw)
      expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }

    binding.dispose()
  })

  it('keeps hidden Codex terminal query chunks on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[c')

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))

    binding.dispose()
  })

  it('keeps only coalesced hidden Codex terminal queries on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    const coalescedChunk = `\x1b[c\x1b[?2026h\x1b[2J\x1b[H${'codex redraw '.repeat(8_000)}`
    capturedDataCallback.current?.(coalescedChunk)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(coalescedChunk, expect.any(Function))

    binding.dispose()
  })

  it('answers hidden OSC color queries directly inside a mixed capability-query burst', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    const queryBurst = '\x1b[c\x1b]11;?\x1b\\\x1b[>q\x1b[14t\x1b[16t'
    const coalescedChunk = `${queryBurst}\x1b[?2026h${'codex redraw '.repeat(8_000)}`
    capturedDataCallback.current?.(coalescedChunk)

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '\x1b[c\x1b[>q\x1b[14t\x1b[16t',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(coalescedChunk, expect.any(Function))

    binding.dispose()
  })

  it('answers adjacent hidden Codex OSC color queries directly', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    const queries = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
    capturedDataCallback.current?.(`${queries}startup frame\r\n`)

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith(queries, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `${queries}startup frame\r\n`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps split hidden Codex terminal queries on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[')
    capturedDataCallback.current?.(`c\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `c\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps hidden Codex terminal queries split after ESC on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b')
    capturedDataCallback.current?.(`[c\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `[c\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('flushes pending hidden Codex query prefixes when the pane becomes visible', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b')
      isVisibleRef.current = true
      capturedDataCallback.current?.('[c')

      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('keeps split hidden-to-visible Codex stateful queries behind snapshot restore', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-before-cpr\r\n',
      cols: 100,
      rows: 30
    })

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[6')
      isVisibleRef.current = true
      capturedDataCallback.current?.('n')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        'snapshot-before-cpr\r\n',
        expect.any(Function)
      )
      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[6n', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('preserves live agent cursor and focus modes on hidden-to-visible snapshot restore', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'agent-frame\x1b[?25l',
      cols: 100,
      rows: 30
    })
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const now = Date.now()
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: '',
      agentType: 'codex',
      paneKey,
      terminalTitle: 'codex',
      updatedAt: now,
      stateStartedAt: now,
      stateHistory: []
    }

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[6')
      isVisibleRef.current = true
      capturedDataCallback.current?.('n')
      await flushAsyncTicks(20)

      // A live agent owns ?1004h (focus reporting); the plain reset's ?1004l would silence focus events until restart, since agents only enable it at startup.
      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        POST_REPLAY_LIVE_SNAPSHOT_RESET,
        expect.any(Function)
      )
    } finally {
      binding.dispose()
    }
  })

  it('resets cursor and focus modes on hidden-to-visible snapshot restore without a live agent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'shell-frame\x1b[?25l',
      cols: 100,
      rows: 30
    })

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[6')
      isVisibleRef.current = true
      capturedDataCallback.current?.('n')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_LIVE_SNAPSHOT_RESET,
        expect.any(Function)
      )
    } finally {
      binding.dispose()
    }
  })

  it('keeps all visible bytes after a pending hidden ESC becomes non-query output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-before-visible\r\n',
      cols: 100,
      rows: 30
    })

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b')
      isVisibleRef.current = true
      capturedDataCallback.current?.('hello')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith('hello', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith('ello', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('repaints from the main-owned snapshot when main drops pending output at the cap', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { droppedOutput?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'healed from snapshot\r\n',
      cols: 100,
      rows: 30
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({ isVisibleRef: { current: true } }) as never
    )
    try {
      await flushAsyncTicks(6)
      getMainBufferSnapshot.mockClear()

      // Main hit the per-PTY pending cap and sent the droppedOutput sentinel: the stream has a gap, so repaint from the authoritative main-owned buffer.
      capturedDataCallback.current?.('', { droppedOutput: true })
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalled()
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining('healed from snapshot'),
        expect.any(Function)
      )
    } finally {
      binding.dispose()
    }
  })

  it('keeps split stateful Codex queries live after becoming visible', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-before-visible\r\n',
      cols: 100,
      rows: 30
    })

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[')
      isVisibleRef.current = true
      capturedDataCallback.current?.('6n')
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[6n', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith('6n', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('drops pending hidden Codex query prefixes when the PTY changes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const isVisibleRef = { current: false }
    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef,
        startup: { command: 'codex' }
      }) as never
    )
    try {
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b')
      ;(transport.attach as unknown as (opts: { existingPtyId: string }) => void)({
        existingPtyId: 'pty-new'
      })
      isVisibleRef.current = true
      capturedDataCallback.current?.('[c')

      expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b', expect.any(Function))
      expect(pane.terminal.write).toHaveBeenCalledWith('[c', expect.any(Function))
    } finally {
      binding.dispose()
    }
  })

  it('does not live-render split hidden Codex non-query CSI output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[?202')
    capturedDataCallback.current?.('6h')
    capturedDataCallback.current?.('\x1b[?203')
    capturedDataCallback.current?.('1h')

    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b[?202', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith('6h', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b[?203', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith('1h', expect.any(Function))

    binding.dispose()
  })

  it('answers split hidden Codex OSC color queries directly', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b]11;?')
    capturedDataCallback.current?.(`\x1b\\\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `\x1b\\\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('answers hidden Codex OSC color queries split before the prefix directly', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b]')
    capturedDataCallback.current?.(`11;?\x1b\\\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

    expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b]11;?\x1b\\', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      `11;?\x1b\\\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
      expect.any(Function)
    )

    binding.dispose()
  })

  it('keeps later hidden Codex stateless terminal queries on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(30_000)
      capturedDataCallback.current?.('\x1b[5n')
      vi.advanceTimersByTime(50)

      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[5n', expect.any(Function))
    } finally {
      vi.useRealTimers()
    }

    binding.dispose()
  })

  it('keeps clean hidden Codex stateful cursor-position queries on the live xterm path', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[10;20H\x1b[6n')

    expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[10;20H\x1b[6n', expect.any(Function))

    binding.dispose()
  })

  it('does not answer dirty hidden Codex stateful queries from stale xterm state', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const binding = connectPanePty(
      pane as never,
      manager as never,
      createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      }) as never
    )
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(`\x1b[2J\x1b[H${'codex redraw '.repeat(8_000)}`)
    capturedDataCallback.current?.('\x1b[6n')

    expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith('\x1b[6n', expect.any(Function))

    binding.dispose()
  })

  it('does not apply stale background Codex query chunks after hidden snapshot restore', async () => {
    // Fire-all like a real event target: both the pane resync and stale-visibility trust handlers listen for visibilitychange.
    const visibilityChangeListeners: (() => void)[] = []
    const visibilityChangeHandler = {
      current: (): void => {
        for (const listener of visibilityChangeListeners) {
          listener()
        }
      }
    }
    ;(globalThis as { document?: Document }).document = {
      visibilityState: 'visible',
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') {
          visibilityChangeListeners.push(listener as () => void)
        }
      }),
      removeEventListener: vi.fn()
    } as unknown as Document

    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current:
        | ((
            data: string,
            meta?: { seq?: number; rawLength?: number; background?: boolean }
          ) => void)
        | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >

    const hiddenFrame = '\r\x1b[2KWorking hidden'
    const staleQueryFrame = '\r\x1b[2KWorking stale\x1b[6n'
    const currentFrame = '\r\x1b[2KWorking current'
    const staleSeq = hiddenFrame.length + staleQueryFrame.length
    const currentSeq = staleSeq + currentFrame.length
    // The main emulator already parsed every frame, so the snapshot covers the query frame still in flight on the pty:data channel.
    getMainBufferSnapshot.mockResolvedValue({
      data: currentFrame,
      cols: 80,
      rows: 8,
      seq: currentSeq
    })

    const pane = createPane(1)
    pane.terminal.cols = 80
    pane.terminal.rows = 8
    const writes: string[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' }
    })
    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hiddenFrame, {
      seq: hiddenFrame.length,
      rawLength: hiddenFrame.length
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    visibilityChangeHandler.current?.()
    await flushAsyncTicks(20)

    // The in-flight chunks arrive in channel order after the restore already rebuilt the buffer from the newer snapshot.
    vi.useFakeTimers()
    try {
      capturedDataCallback.current?.(staleQueryFrame, {
        seq: staleSeq,
        rawLength: staleQueryFrame.length,
        background: true
      })
      capturedDataCallback.current?.(currentFrame, {
        seq: currentSeq,
        rawLength: currentFrame.length,
        background: true
      })
      vi.advanceTimersByTime(50)
      await flushAsyncTicks(6)
    } finally {
      vi.useRealTimers()
    }

    const rendererBuffer = await renderHeadlessBuffer(writes, 80, 8)
    const referenceBuffer = await renderHeadlessBuffer(
      [hiddenFrame, staleQueryFrame, currentFrame],
      80,
      8
    )

    expect(writes).not.toContain(staleQueryFrame)
    expect(rendererBuffer).toEqual(referenceBuffer)
    binding.dispose()
  })

  it('restores hidden Codex output after a suppressed exit revives the same ptyId with a restarted seq counter', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current:
        | ((
            data: string,
            meta?: { seq?: number; rawLength?: number; background?: boolean }
          ) => void)
        | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >

    const hiddenFrame = '\r\x1b[2KWorking hidden'
    const visibleFrame = '\r\x1b[2KWorking now'
    const hiddenSeq = hiddenFrame.length
    const visibleSeq = hiddenSeq + visibleFrame.length
    // Why 3 extra bytes: the main emulator runs ahead of the renderer's received chunks, so the snapshot seq exceeds the channel seq.
    const preExitSnapshotSeq = visibleSeq + 3
    getMainBufferSnapshot.mockResolvedValue({
      data: visibleFrame,
      cols: 80,
      rows: 8,
      seq: preExitSnapshotSeq
    })

    const pane = createPane(1)
    pane.terminal.cols = 80
    pane.terminal.rows = 8
    const writes: string[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' },
      consumeSuppressedPtyExit: vi.fn(() => true)
    })
    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hiddenFrame, { seq: hiddenSeq, rawLength: hiddenFrame.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(visibleFrame, {
      seq: visibleSeq,
      rawLength: visibleFrame.length
    })
    await flushAsyncTicks(20)

    const onPtyExit = createdTransportOptions[0]?.onPtyExit as ((ptyId: string) => void) | undefined
    expect(onPtyExit).toBeTypeOf('function')
    onPtyExit?.('pty-id')

    // Revived session: same ptyId, seq restarted — the revived chunk sits below the pre-exit snapshot seq; only the exit reset stops it being judged covered.
    ;(deps.isVisibleRef as { current: boolean }).current = false
    const revivedHiddenFrame = '\r\x1b[2KWorking revived'
    capturedDataCallback.current?.(revivedHiddenFrame, {
      seq: preExitSnapshotSeq - 1,
      rawLength: revivedHiddenFrame.length
    })

    const revivedSnapshotFrame = '\r\x1b[2KREVIVED SNAPSHOT'
    getMainBufferSnapshot.mockResolvedValue({
      data: revivedSnapshotFrame,
      cols: 80,
      rows: 8,
      seq: preExitSnapshotSeq - 1
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    const revivedVisibleFrame = '\r\x1b[2Kafter revive'
    capturedDataCallback.current?.(revivedVisibleFrame, {
      seq: preExitSnapshotSeq - 1 + revivedVisibleFrame.length,
      rawLength: revivedVisibleFrame.length
    })
    await flushAsyncTicks(20)

    const written = writes.join('')
    expect(written).toContain('REVIVED SNAPSHOT')
    expect(written).toContain('after revive')
    binding.dispose()
  })

  it('restores hidden Codex output when the pty seq counter restarts without an observed exit', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current:
        | ((
            data: string,
            meta?: { seq?: number; rawLength?: number; background?: boolean }
          ) => void)
        | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >

    const pane = createPane(1)
    pane.terminal.cols = 80
    pane.terminal.rows = 8
    const writes: string[] = []
    pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
      writes.push(data)
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: true },
      startup: { command: 'codex' }
    })
    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    const establishedFrame = '\r\x1b[2KWorking established'
    capturedDataCallback.current?.(establishedFrame, {
      seq: 50_000,
      rawLength: establishedFrame.length
    })
    await flushAsyncTicks(6)

    // Main lost the pty silently and the seq counter restarted; the channel seq regression must invalidate the old high-water mark, not cover the new stream.
    ;(deps.isVisibleRef as { current: boolean }).current = false
    const revivedHiddenFrame = '\r\x1b[2KWorking revived'
    capturedDataCallback.current?.(revivedHiddenFrame, {
      seq: revivedHiddenFrame.length,
      rawLength: revivedHiddenFrame.length
    })

    const revivedSnapshotFrame = '\r\x1b[2KREVIVED SNAPSHOT2'
    getMainBufferSnapshot.mockResolvedValue({
      data: revivedSnapshotFrame,
      cols: 80,
      rows: 8,
      seq: revivedHiddenFrame.length
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    const revivedVisibleFrame = '\r\x1b[2Kafter revive'
    capturedDataCallback.current?.(revivedVisibleFrame, {
      seq: revivedHiddenFrame.length + revivedVisibleFrame.length,
      rawLength: revivedVisibleFrame.length
    })
    await flushAsyncTicks(20)

    expect(writes.join('')).toContain('REVIVED SNAPSHOT2')
    binding.dispose()
  })

  it('writes ordinary hidden output live instead of proactively restoring a snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'small-hidden-output\r\n'
    const live = 'visible-after-hidden\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: `snapshot-with-${hidden}`,
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden, expect.any(Function))

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(hidden)
    expect(pane.terminal.write).toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('restores overflowed hidden remote runtime output from its serialized snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    // Why: with the skip grammar gone, remote-runtime model restore is latched by background-queue overflow, not per-chunk scanning.
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible remote output\r\n'
    transport.serializeBuffer = vi.fn().mockResolvedValue({
      data: 'remote snapshot with hidden remote output\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length + live.length,
      source: 'headless'
    })
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'remote:env-1@@terminal-1'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ isVisibleRef: { current: false } })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden, expect.any(Function))

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(transport.serializeBuffer).toHaveBeenCalledWith({ scrollbackRows: 5000 })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      expect.stringContaining('remote snapshot with hidden remote output'),
      expect.any(Function)
    )
    disposable.dispose()
  })

  it('defers inactive split-pane plain hidden output restore until the pane returns', async () => {
    const { resetHiddenOutputRestoreSchedulerForTests } =
      await import('./hidden-output-restore-scheduler')
    let disposable: { dispose: () => void } | null = null
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'inactive snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })

      const pane = createPane(1)
      const manager = createManager(2)
      manager.getActivePane.mockReturnValue({ id: 2 })
      const deps = createDeps({ isVisibleRef: { current: false } })
      disposable = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      // Why: overflowing the background queue latches the model restore now — the per-chunk skip grammar is gone.
      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const live = 'visible inactive output\r\n'
      expect(capturedDataCallback.current).not.toBeNull()
      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      await flushAsyncTicks(4)

      expect(getMainBufferSnapshot).not.toHaveBeenCalled()

      // Why: inactive split restore is frame-spaced, so wait past one scheduler tick without fake timers for xterm callbacks.
      await new Promise((resolve) => setTimeout(resolve, 30))
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
      expect(pane.terminal.write).not.toHaveBeenCalledWith(hidden)
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining('inactive snapshot'),
        expect.any(Function)
      )
    } finally {
      disposable?.dispose()
      resetHiddenOutputRestoreSchedulerForTests()
    }
  })

  it('drops a deferred inactive hidden restore when the pane is hidden again', async () => {
    const { resetHiddenOutputRestoreSchedulerForTests } =
      await import('./hidden-output-restore-scheduler')
    let disposable: { dispose: () => void } | null = null
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'inactive snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: 64
      })

      const pane = createPane(1)
      const manager = createManager(2)
      manager.getActivePane.mockReturnValue({ id: 2 })
      const deps = createDeps({ isVisibleRef: { current: false } })
      disposable = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      // Why: overflow latches the model restore (no skip grammar remains).
      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const live = 'visible inactive output\r\n'
      expect(capturedDataCallback.current).not.toBeNull()
      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      ;(deps.isVisibleRef as { current: boolean }).current = false
      await new Promise((resolve) => setTimeout(resolve, 30))
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        'inactive snapshot\r\n',
        expect.any(Function)
      )
    } finally {
      disposable?.dispose()
      resetHiddenOutputRestoreSchedulerForTests()
    }
  })

  it('retries null remote snapshots for overflowed hidden runtime output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.serializeBuffer = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({
      data: 'remote recovered snapshot\r\n',
      cols: 120,
      rows: 40,
      seq: 80,
      source: 'headless'
    })
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'remote:env-1@@terminal-1'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ isVisibleRef: { current: false } })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    // Why: overflow latches the model restore (no skip grammar remains).
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const firstLive = 'first visible output\r\n'
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(firstLive, {
      seq: hidden.length + firstLive.length,
      rawLength: firstLive.length
    })
    await flushAsyncTicks(20)

    expect(transport.serializeBuffer).toHaveBeenCalledTimes(1)
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('Orca skipped hidden terminal output'),
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'remote recovered snapshot\r\n',
      expect.any(Function)
    )

    await new Promise((resolve) => setTimeout(resolve, 80))
    await flushAsyncTicks(20)

    expect(transport.serializeBuffer).toHaveBeenCalledTimes(2)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      expect.stringContaining('remote recovered snapshot'),
      expect.any(Function)
    )
    disposable.dispose()
  })

  // Why: pins the switch-off hidden fallback chain — 2MB lossy cap drops the backlog, latches restore, and reveal repaints from the model snapshot.
  it('restores hidden backlog overflow from the main terminal snapshot on foreground output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalled()

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.resize).toHaveBeenCalledWith(100, 30)
    expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H', expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith('snapshot-state\r\n', expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('rebuilds normal and alternate buffers from an authoritative alternate snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after-altscreen\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'altscreen-snapshot\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length,
      alternateScreen: true,
      scrollbackAnsi: 'preserved-shell-history\r\n'
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    expect(pane.terminal.write).not.toHaveBeenCalled()

    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '\x1b[?1049l\x1b[2J\x1b[3J\x1b[H',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'preserved-shell-history\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '\x1b[0m\x1b[?1049h\x1b[2J\x1b[H',
      expect.any(Function)
    )
    const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0]
    )
    expect(writes.indexOf('preserved-shell-history\r\n')).toBeLessThan(
      writes.indexOf('\x1b[0m\x1b[?1049h\x1b[2J\x1b[H')
    )
    expect(writes.indexOf('\x1b[0m\x1b[?1049h\x1b[2J\x1b[H')).toBeLessThan(
      writes.indexOf('altscreen-snapshot\r\n')
    )
    expect(pane.terminal.write).toHaveBeenCalledWith('altscreen-snapshot\r\n', expect.any(Function))
    disposable.dispose()
  })

  it('drains foreground output after a renderer-sourced hidden-backlog snapshot without seq', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after-renderer-fallback\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'renderer-snapshot-state\r\n',
      cols: 100,
      rows: 30,
      source: 'renderer'
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith(
      'renderer-snapshot-state\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('slices abandoned pending chunks against a replay that already painted', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const snapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
      pendingDeliveryStartSeq: number
    }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    const hidden = 'hidden-codex-output\r\n'
    const coveredLive = 'LIVE_DUP_LINE\r\n'
    const afterAbandon = 'AFTER_ABANDON\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)
    expect(capturedDataCallback.current).not.toBeNull()

    vi.useFakeTimers()
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(coveredLive, {
      seq: hidden.length + coveredLive.length,
      rawLength: coveredLive.length
    })
    await flushAsyncTicks(4)

    const heldCallbacks: (() => void)[] = []
    pane.terminal.write.mockImplementation(function write(
      data: string,
      callback?: () => void
    ): void {
      if (callback) {
        heldCallbacks.push(callback)
      }
      void data
    })
    snapshot.resolve({
      data: 'SNAP_STATE\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + coveredLive.length,
      pendingDeliveryStartSeq: 0
    })
    await flushAsyncTicks(6)

    vi.advanceTimersByTime(750)
    await flushAsyncTicks(10)

    const writtenAfterAbandon = pane.terminal.write.mock.calls.map(([data]) => data as string)
    expect(writtenAfterAbandon.join('')).not.toContain('LIVE_DUP_LINE')

    pane.terminal.write.mockClear()
    capturedDataCallback.current?.(coveredLive, {
      seq: hidden.length + coveredLive.length,
      rawLength: coveredLive.length
    })
    await flushAsyncTicks(4)
    expect(pane.terminal.write.mock.calls.map(([data]) => data as string).join('')).not.toContain(
      'LIVE_DUP_LINE'
    )

    capturedDataCallback.current?.(afterAbandon, {
      seq: hidden.length + coveredLive.length + afterAbandon.length,
      rawLength: afterAbandon.length
    })
    await flushAsyncTicks(4)
    expect(pane.terminal.write.mock.calls.map(([data]) => data as string).join('')).toContain(
      'AFTER_ABANDON'
    )

    heldCallbacks.forEach((callback) => callback())
    disposable.dispose()
  })

  it('abandons a stalled hidden restore and drains pending foreground chunks warning-first', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    const hidden = 'hidden-codex-output\r\n'
    const firstLive = 'first-live-output\r\n'
    const secondLive = 'second-live-output\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(firstLive, {
      seq: hidden.length + firstLive.length,
      rawLength: firstLive.length
    })
    await flushAsyncTicks(4)
    capturedDataCallback.current?.(secondLive, {
      seq: hidden.length + firstLive.length + secondLive.length,
      rawLength: secondLive.length
    })

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(firstLive, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(secondLive, expect.any(Function))

    vi.advanceTimersByTime(749)
    await flushAsyncTicks(4)
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      expect.stringContaining('main recovery was unavailable'),
      expect.any(Function)
    )

    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)

    const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
    const warningIndex = written.findIndex((data) => data.includes('main recovery was unavailable'))
    const combinedLiveIndex = written.indexOf(firstLive + secondLive)
    expect(warningIndex).toBeGreaterThanOrEqual(0)
    expect(combinedLiveIndex).toBeGreaterThan(warningIndex)

    snapshot.resolve({
      data: 'late-snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + firstLive.length + secondLive.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'late-snapshot-state\r\n',
      expect.any(Function)
    )
    disposable.dispose()
  })

  it('falls back after repeated null hidden restore retries and drains blocked foreground', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue(null)
    const hidden = 'hidden-codex-output\r\n'
    const live = 'visible-after-null-retries\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(10)

    for (let attempt = 0; attempt < 3; attempt++) {
      expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
      vi.advanceTimersByTime(50)
      vi.advanceTimersByTime(0)
      await flushAsyncTicks(10)
    }

    const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
    const warningIndex = written.findIndex((data) => data.includes('main recovery was unavailable'))
    const liveIndex = written.indexOf(live)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(4)
    expect(warningIndex).toBeGreaterThanOrEqual(0)
    expect(liveIndex).toBeGreaterThan(warningIndex)
    disposable.dispose()
  })

  it('drops pending foreground overflow when a stalled hidden restore falls back', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockReturnValue(
      createDeferred<{ data: string; cols: number; rows: number; seq: number }>().promise
    )
    const hidden = 'hidden-codex-output\r\n'
    const liveOverflow = 'v'.repeat(512 * 1024 + 1)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(liveOverflow, {
      seq: hidden.length + liveOverflow.length,
      rawLength: liveOverflow.length
    })
    await flushAsyncTicks(4)

    await vi.advanceTimersByTimeAsync(750)
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith(
      expect.stringContaining('main recovery was unavailable'),
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(liveOverflow, expect.any(Function))
    disposable.dispose()
  })

  it('coalesces tiny pending foreground chunks when stalled hidden restore falls back', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockReturnValue(
      createDeferred<{ data: string; cols: number; rows: number; seq: number }>().promise
    )
    const hidden = 'hidden-codex-output\r\n'
    const chunkCount = 2_000
    const liveChunk = 'x'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    for (let index = 0; index < chunkCount; index += 1) {
      capturedDataCallback.current?.(liveChunk, {
        seq: hidden.length + index + 1,
        rawLength: liveChunk.length
      })
    }
    await flushAsyncTicks(4)

    vi.advanceTimersByTime(750)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)

    const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
    const warningIndex = written.findIndex((data) => data.includes('main recovery was unavailable'))
    const combinedLive = liveChunk.repeat(chunkCount)
    const liveWrites = written.filter((data) => data === combinedLive)
    expect(warningIndex).toBeGreaterThanOrEqual(0)
    expect(liveWrites).toHaveLength(1)
    expect(written.indexOf(combinedLive)).toBeGreaterThan(warningIndex)

    disposable.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps foreground output when hidden-backlog snapshot recovery is unavailable', async () => {
    const pendingTimeouts: {
      canceled: boolean
      delay: number
      fn: () => void
      id: number
    }[] = []
    const originalSetTimeout = globalThis.setTimeout
    const originalClearTimeout = globalThis.clearTimeout
    let nextTimeoutId = 1
    globalThis.setTimeout = vi.fn((fn: () => void, delay?: number) => {
      const timeout = {
        canceled: false,
        delay: typeof delay === 'number' ? delay : 0,
        fn,
        id: nextTimeoutId++
      }
      pendingTimeouts.push(timeout)
      return timeout.id as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = vi.fn((id: ReturnType<typeof setTimeout>) => {
      const numericId = id as unknown as number
      const timeout = pendingTimeouts.find((candidate) => candidate.id === numericId)
      if (timeout) {
        timeout.canceled = true
      }
    }) as unknown as typeof clearTimeout

    const runNextTimeoutWithDelay = async (delay: number): Promise<void> => {
      const index = pendingTimeouts.findIndex(
        (timeout) => !timeout.canceled && timeout.delay === delay
      )
      expect(index).toBeGreaterThanOrEqual(0)
      const [timeout] = pendingTimeouts.splice(index, 1)
      timeout.fn()
      await flushAsyncTicks(20)
    }
    const drainTimeoutsWithDelay = async (delay: number): Promise<void> => {
      while (pendingTimeouts.some((timeout) => !timeout.canceled && timeout.delay === delay)) {
        await runNextTimeoutWithDelay(delay)
      }
    }

    let disposable: { dispose: () => void } | null = null
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue(null)

      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const live = 'foreground-after-unavailable\r\n'
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false }
      })
      disposable = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        expect.stringContaining(live),
        expect.any(Function)
      )

      await runNextTimeoutWithDelay(50)
      await runNextTimeoutWithDelay(50)
      await runNextTimeoutWithDelay(50)
      await drainTimeoutsWithDelay(0)

      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(4)
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining(
          'Orca skipped hidden terminal output because main recovery was unavailable.'
        ),
        expect.any(Function)
      )
      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining(live),
        expect.any(Function)
      )
    } finally {
      disposable?.dispose()
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    }
  })

  it('keeps a newer same-PTY hidden restore after a timed-out snapshot resolves late', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const firstSnapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
    }>()
    const secondSnapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
    }>()
    getMainBufferSnapshot
      .mockReturnValueOnce(firstSnapshot.promise)
      .mockReturnValueOnce(secondSnapshot.promise)
    const firstHidden = 'first-hidden-output\r\n'
    const firstLive = 'first-live-output\r\n'
    const secondHidden = 'second-hidden-output\r\n'
    const secondLive = 'second-live-output\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false },
      startup: { command: 'codex' }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    expect(capturedDataCallback.current).not.toBeNull()
    vi.useFakeTimers()
    capturedDataCallback.current?.(firstHidden, {
      seq: firstHidden.length,
      rawLength: firstHidden.length
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(firstLive, {
      seq: firstHidden.length + firstLive.length,
      rawLength: firstLive.length
    })
    await flushAsyncTicks(4)
    vi.advanceTimersByTime(750)
    vi.advanceTimersByTime(0)
    await flushAsyncTicks(10)

    pane.terminal.write.mockClear()
    ;(deps.isVisibleRef as { current: boolean }).current = false
    capturedDataCallback.current?.(secondHidden, {
      seq: firstHidden.length + firstLive.length + secondHidden.length,
      rawLength: secondHidden.length
    })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(secondLive, {
      seq: firstHidden.length + firstLive.length + secondHidden.length + secondLive.length,
      rawLength: secondLive.length
    })
    await flushAsyncTicks(4)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)

    firstSnapshot.resolve({
      data: 'stale-first-snapshot\r\n',
      cols: 100,
      rows: 30,
      seq: firstHidden.length + firstLive.length
    })
    await flushAsyncTicks(10)
    secondSnapshot.resolve({
      data: 'fresh-second-snapshot\r\n',
      cols: 100,
      rows: 30,
      seq: firstHidden.length + firstLive.length + secondHidden.length + secondLive.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'stale-first-snapshot\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'fresh-second-snapshot\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(secondLive, expect.any(Function))
    disposable.dispose()
  })

  it('ignores an async hidden-backlog snapshot if the pane changes PTYs first', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('old-pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'old-pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'old-live-output\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(2)
    transport.getPtyId.mockReturnValue('new-pty-id')
    snapshot.resolve({
      data: 'old-snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('old-pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      'old-snapshot-state\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('does not recover stale hidden backlog state after the pane switches PTYs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('old-pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'old-pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const newPtyOutput = 'new-pty-output\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    transport.getPtyId.mockReturnValue('new-pty-id')
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(newPtyOutput, {
      seq: newPtyOutput.length,
      rawLength: newPtyOutput.length
    })
    await flushAsyncTicks(10)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(newPtyOutput, expect.any(Function))
    disposable.dispose()
  })

  it('does not replay pending hidden restore chunks after a terminal clear', async () => {
    const clearBufferCallback: {
      current: ((request: { ptyId: string }) => void) | null
    } = { current: null }
    window.api.pty.onClearBufferRequest = vi.fn((callback) => {
      clearBufferCallback.current = callback as (request: { ptyId: string }) => void
      return vi.fn()
    })
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
    getMainBufferSnapshot.mockReturnValue(snapshot.promise)
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'pre-clear-live-output\r\n'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(2)
    expect(clearBufferCallback.current).not.toBeNull()

    clearBufferCallback.current?.({ ptyId: 'pty-id' })
    snapshot.resolve({
      data: '',
      cols: 120,
      rows: 40,
      seq: hidden.length + live.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.clear).toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b[2J\x1b[3J\x1b[H',
      expect.any(Function)
    )
    disposable.dispose()
  })

  it('keeps recovery pending when hidden output arrives during an in-flight snapshot', async () => {
    let visibilityState: DocumentVisibilityState = 'visible'
    // Fire-all like a real event target: both the pane resync and stale-visibility trust handlers listen for visibilitychange.
    const visibilityChangeListeners: (() => void)[] = []
    const visibilityChangeHandler = {
      current: (): void => {
        for (const listener of visibilityChangeListeners) {
          listener()
        }
      }
    }
    ;(globalThis as { document?: Document }).document = {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') {
          visibilityChangeListeners.push(listener as () => void)
        }
      }),
      removeEventListener: vi.fn()
    } as unknown as Document

    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
    const firstSnapshot = createDeferred<{
      data: string
      cols: number
      rows: number
      seq: number
    }>()
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const visibleLive = 'visible-before-hide\r\n'
    const hiddenAgain = 'hidden-during-restore\r\n'
    getMainBufferSnapshot.mockReturnValueOnce(firstSnapshot.promise).mockResolvedValueOnce({
      data: 'snapshot-after-hidden-again\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length + visibleLive.length + hiddenAgain.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    visibilityState = 'visible'
    capturedDataCallback.current?.(visibleLive, {
      seq: hidden.length + visibleLive.length,
      rawLength: visibleLive.length
    })
    await flushAsyncTicks(2)
    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

    ;(deps.isVisibleRef as { current: boolean }).current = false
    visibilityState = 'hidden'
    capturedDataCallback.current?.(hiddenAgain, {
      seq: hidden.length + visibleLive.length + hiddenAgain.length,
      rawLength: hiddenAgain.length
    })
    transport.resize.mockClear()
    signalPty.mockClear()
    firstSnapshot.resolve({
      data: 'snapshot-before-hidden-again\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + visibleLive.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-before-hidden-again\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(hiddenAgain, expect.any(Function))
    expect(transport.resize).not.toHaveBeenCalled()
    expect(signalPty).not.toHaveBeenCalledWith('pty-id', 'SIGWINCH')

    ;(deps.isVisibleRef as { current: boolean }).current = true
    visibilityState = 'visible'
    visibilityChangeHandler.current?.()
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-after-hidden-again\r\n',
      expect.any(Function)
    )
    disposable.dispose()
  })

  it('preserves a scrolled-up viewport after hidden-backlog snapshot replay', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    pane.terminal.buffer.active.viewportY = 42
    pane.terminal.buffer.active.baseY = 100
    pane.terminal.write.mockImplementation((data: string, callback?: () => void) => {
      if (data.includes('snapshot-state')) {
        pane.terminal.buffer.active.viewportY = 0
      }
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith('snapshot-state\r\n', expect.any(Function))
    expect(pane.terminal.scrollToLine).toHaveBeenCalledWith(42)
    disposable.dispose()
  })

  it('cancels a delayed snapshot scroll restore when the pane binding is disposed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { isTerminalScrollIntentRebuildInFlight } =
      await import('@/lib/pane-manager/terminal-scroll-intent-rebuild')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    pane.terminal.buffer.active.viewportY = 42
    pane.terminal.buffer.active.baseY = 100
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({ isVisibleRef: { current: false } })
    const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(writes).toContain('snapshot-state\r\n')
    expect(isTerminalScrollIntentRebuildInFlight(pane.terminal)).toBe(true)
    pane.terminal.scrollToLine.mockClear()
    disposable.dispose()
    expect(isTerminalScrollIntentRebuildInFlight(pane.terminal)).toBe(true)

    pane.terminal.buffer.active.baseY = 200
    pane.terminal.buffer.active.viewportY = 200
    for (const callback of parseCallbacks) {
      callback()
    }
    await flushAsyncTicks()

    expect(isTerminalScrollIntentRebuildInFlight(pane.terminal)).toBe(false)
    expect(pane.terminal.scrollToLine).not.toHaveBeenCalled()
  })

  it('does not apply a delayed snapshot restore after newer user intent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markTerminalFollowOutput } = await import('@/lib/pane-manager/terminal-scroll-intent')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-state\r\n',
      cols: 100,
      rows: 30,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    pane.terminal.buffer.active.viewportY = 42
    pane.terminal.buffer.active.baseY = 100
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const deps = createDeps({ isVisibleRef: { current: false } })
    const disposable = connectPanePty(pane as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(writes).toContain('snapshot-state\r\n')
    pane.terminal.buffer.active.viewportY = 200
    pane.terminal.buffer.active.baseY = 200
    markTerminalFollowOutput(pane.terminal)
    pane.terminal.scrollToLine.mockClear()
    for (const callback of parseCallbacks) {
      callback()
    }
    await flushAsyncTicks()

    // Why: replay completion must not overwrite scroll intent recorded while xterm was still parsing the restored snapshot.
    expect(pane.terminal.scrollToLine).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('does not signal SIGWINCH after hidden-backlog snapshot replay when dimensions are unchanged', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'visible-after\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-state\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)
    transport.resize.mockClear()
    signalPty.mockClear()

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith('snapshot-state\r\n', expect.any(Function))
    expect(transport.resize).not.toHaveBeenCalledWith(120, 40)
    expect(signalPty).not.toHaveBeenCalledWith('pty-id', 'SIGWINCH')
    disposable.dispose()
  })

  it('skips a background-origin alternate-screen frame and pulses a PTY repaint', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current:
        | ((
            data: string,
            meta?: { seq?: number; rawLength?: number; background?: boolean }
          ) => void)
        | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
    const staleHiddenTuiFrame = '\x1b[2Khidden-width codex composer\r\n'

    const pane = createPane(1)
    pane.terminal.cols = 133
    pane.terminal.rows = 40
    ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: true }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)
    getMainBufferSnapshot.mockClear()
    transport.resize.mockClear()
    signalPty.mockClear()

    capturedDataCallback.current?.(staleHiddenTuiFrame, {
      seq: staleHiddenTuiFrame.length,
      rawLength: staleHiddenTuiFrame.length,
      background: true
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).not.toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith(staleHiddenTuiFrame, expect.any(Function))
    expect(transport.resize).toHaveBeenCalledWith(132, 40)
    expect(transport.resize).toHaveBeenCalledWith(133, 40)
    expect(signalPty).not.toHaveBeenCalledWith('pty-id', 'SIGWINCH')
    disposable.dispose()
  })

  it('does not forward terminal resizes while the pane is hidden', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const manager = createManager(1)
    const isVisibleRef = { current: false }
    const deps = createDeps({ isVisibleRef })

    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    const onResizeMock = pane.terminal.onResize as unknown as {
      mock: { calls: [[(event: { cols: number; rows: number }) => void] | []] }
    }
    const resizeHandler = onResizeMock.mock.calls[0]?.[0]
    if (!resizeHandler) {
      throw new Error('Expected terminal resize handler to be registered')
    }

    transport.resize.mockClear()
    resizeHandler({ cols: 121, rows: 41 })

    expect(transport.resize).not.toHaveBeenCalled()

    isVisibleRef.current = true
    resizeHandler({ cols: 122, rows: 42 })

    expect(transport.resize).toHaveBeenCalledWith(122, 42, { claim: true })
    disposable.dispose()
  })

  it('writes foreground chunks that are newer than the restored main snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = 'new-live-output\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-before-live\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-before-live\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('writes only the live chunk suffix not covered by the restored main snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const livePrefix = 'covered-by-snapshot:'
    const liveSuffix = 'still-new\r\n'
    const live = livePrefix + liveSuffix
    getMainBufferSnapshot.mockResolvedValue({
      data: 'snapshot-through-live-prefix\r\n',
      cols: 120,
      rows: 40,
      seq: hidden.length + livePrefix.length
    })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-through-live-prefix\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(liveSuffix, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
    disposable.dispose()
  })

  it('re-snapshots instead of duplicating partially overlapped chunks with stripped OSC bytes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const cleanedLive = 'clean-visible-output\r\n'
    const rawLiveLength = cleanedLive.length + 32
    getMainBufferSnapshot
      .mockResolvedValueOnce({
        data: 'snapshot-splits-osc-live\r\n',
        cols: 120,
        rows: 40,
        seq: hidden.length + 4
      })
      .mockResolvedValueOnce({
        data: 'snapshot-after-osc-live\r\n',
        cols: 120,
        rows: 40,
        seq: hidden.length + rawLiveLength
      })

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(cleanedLive, {
      seq: hidden.length + rawLiveLength,
      rawLength: rawLiveLength
    })
    await flushAsyncTicks(30)

    expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'snapshot-after-osc-live\r\n',
      expect.any(Function)
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(cleanedLive, expect.any(Function))
    disposable.dispose()
  })

  it('replays rich headless snapshots as the future hidden TUI view source', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const richSnapshot = [
      '\x1b[?1049h',
      '\x1b[2J\x1b[H',
      '\x1b[?25l',
      '\x1b[2;36m╭────────────────────────────╮\x1b[0m\r\n',
      '\x1b[2;36m│ Codex rich restore 🟢 ███░ │\x1b[0m\r\n',
      '\x1b[2;36m│ status streaming           │\x1b[0m\r\n',
      '\x1b[2;36m╰────────────────────────────╯\x1b[0m',
      '\x1b[6;4H\x1b[?25h'
    ].join('')
    const visibleTrigger = 'visible-trigger\r\n'
    getMainBufferSnapshot.mockResolvedValue({
      data: richSnapshot,
      cols: 96,
      rows: 18,
      seq: hidden.length + visibleTrigger.length,
      source: 'headless'
    })

    const pane = createPane(1)
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(visibleTrigger, {
      seq: hidden.length + visibleTrigger.length,
      rawLength: visibleTrigger.length
    })
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
    expect(pane.terminal.resize).toHaveBeenCalledWith(96, 18)
    expect(pane.terminal.write).toHaveBeenCalledWith(richSnapshot, expect.any(Function))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(visibleTrigger, expect.any(Function))
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
    expect(deps.replayingPanesRef.current.size).toBe(0)
    disposable.dispose()
  })

  it('refreshes visible rows after replaying a hidden TUI snapshot', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedDataCallback: {
      current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
    const live = '\x1b[?2026h\x1b[2J\x1b[H╭────╮\r\n│ ok │\r\n╰────╯\x1b[?2026l'
    getMainBufferSnapshot.mockResolvedValue({
      data: live,
      cols: 120,
      rows: 40,
      seq: hidden.length + live.length
    })

    const pane = createPane(1)
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
    ;(deps.isVisibleRef as { current: boolean }).current = true
    capturedDataCallback.current?.(live, {
      seq: hidden.length + live.length,
      rawLength: live.length
    })
    await flushAsyncTicks(20)

    // Why: hidden restore replays bypass live foreground output; force a paint after parse so stale WebGL cells can't survive.
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
    expect(deps.replayingPanesRef.current.size).toBe(0)
    disposable.dispose()
  })

  it('rebuilds WebGL after remote buffered replay arrives on an already-open pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedReplayCallback: {
      current: ((data: string) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:env-1@@terminal-1', replay: '' }
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedReplayCallback.current?.('remote prompt\r\n$ ')
    await flushAsyncTicks(6)

    expect(pane.terminal.write).toHaveBeenCalledWith('remote prompt\r\n$ ', expect.any(Function))
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
    expect(manager.rebuildPaneWebgl).toHaveBeenCalledWith(1)
    disposable.dispose()
  })

  it('preserves live agent modes when queued replay data carries the Cursor Agent screen', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedReplayCallback: {
      current: ((data: string, meta?: { clearBeforeReplay?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:env-1@@terminal-1', replay: '' }
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('renamed shell')

    const pane = createPane(1)
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = await withMockedDocumentActiveElement(textarea, async () => {
      const connection = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedReplayCallback.current?.(ANSI_POSITIONED_CURSOR_AGENT_REATTACH_SCREEN)
      await flushAsyncTicks(12)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
        expect.any(Function)
      )
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
      return connection
    })
    disposable.dispose()
  })

  it('downgrades a scrollback-only Cursor Agent signal when the parsed viewport shows a shell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedReplayCallback: {
      current: ((data: string, meta?: { clearBeforeReplay?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:env-1@@terminal-1', replay: '' }
    })
    transportFactoryQueue.push(transport)
    setReattachPaneTitle('renamed shell')

    const pane = createPane(1)
    // Why: a buffer whose visible rows carry no Cursor Agent screen models a shell foreground after a dead run left its screen in scrollback.
    Object.assign(pane.terminal.buffer.active, {
      cursorX: 2,
      getLine: () => undefined
    })
    const textarea = {} as HTMLTextAreaElement
    configureTerminalFocusMode(pane, textarea)
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = await withMockedDocumentActiveElement(textarea, async () => {
      const connection = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      // A dead run left the cursor hidden; the live-agent reset preserves ?25l, so the veto must re-show the cursor for the shell.
      capturedReplayCallback.current?.(`${ANSI_POSITIONED_CURSOR_AGENT_REATTACH_SCREEN}\x1b[?25l`)
      await flushAsyncTicks(12)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[?25h\x1b[?1004l', expect.any(Function))
      expect(transport.sendInput).not.toHaveBeenCalledWith('\x1b[I')
      return connection
    })
    disposable.dispose()
  })

  it('does not clear restored scrollback when eager metadata replay opts out', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedReplayCallback: {
      current: ((data: string, meta?: { clearBeforeReplay?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    pane.terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedReplayCallback.current?.('\x1b]0;Restored title\x07', { clearBeforeReplay: false })
    await flushAsyncTicks(6)

    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      '\x1b[2J\x1b[3J\x1b[H',
      expect.any(Function)
    )
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '\x1b]0;Restored title\x07',
      expect.any(Function)
    )
    disposable.dispose()
  })

  it('does not write a clear or reset for empty eager metadata replay', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    const capturedReplayCallback: {
      current: ((data: string, meta?: { clearBeforeReplay?: boolean }) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    pane.terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedReplayCallback.current?.('', { clearBeforeReplay: false })
    await flushAsyncTicks(6)

    expect(pane.terminal.write).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('coalesces remote replay payloads that overlap before parsing starts', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-1')
    const capturedReplayCallback: {
      current: ((data: string) => void) | null
    } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedReplayCallback.current = callbacks.onReplayData ?? null
      return { id: 'remote:env-1@@terminal-1', replay: '' }
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const pendingParses: (() => void)[] = []
    pane.terminal.write = vi.fn((_data: string, callback?: () => void) => {
      if (callback) {
        pendingParses.push(callback)
      }
    })
    const manager = createManager(1)
    const deps = createDeps()
    const disposable = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedReplayCallback.current?.('first replay')
    capturedReplayCallback.current?.('second replay')
    await flushAsyncTicks(6)

    expect(pane.terminal.write).toHaveBeenCalledTimes(1)
    expect(pane.terminal.write).toHaveBeenNthCalledWith(
      1,
      '\x1b[2J\x1b[3J\x1b[H',
      expect.any(Function)
    )

    for (let index = 0; index < 8; index += 1) {
      await flushAsyncTicks(2)
      pendingParses.shift()?.()
    }
    await flushAsyncTicks(4)

    expect(pane.terminal.write).not.toHaveBeenCalledWith('first replay', expect.any(Function))
    expect(pane.terminal.write).toHaveBeenCalledWith('second replay', expect.any(Function))
    expect(manager.rebuildPaneWebgl).toHaveBeenCalledTimes(1)
    disposable.dispose()
  })

  it('holds newer live bytes until a later replay frame has fully parsed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { deliverTerminalDataWithDeferredCredit } =
      await import('@/lib/pane-manager/terminal-delivery-credit')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-live-order')
    const callbacksRef: {
      replay: ((data: string) => void) | null
      data: ((data: string) => void) | null
    } = { replay: null, data: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      callbacksRef.replay = callbacks.onReplayData ?? null
      callbacksRef.data = callbacks.onData ?? null
      return 'remote:env-1@@terminal-live-order'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(8)

    callbacksRef.replay?.('authoritative replay')
    await flushAsyncTicks(8)
    expect(writes).toEqual(['\x1b[2J\x1b[3J\x1b[H'])

    const acknowledgeLiveFrame = vi.fn()
    deliverTerminalDataWithDeferredCredit(acknowledgeLiveFrame, () => {
      callbacksRef.data?.('NEWER-LIVE\r\n')
    })
    expect(writes).not.toContain('NEWER-LIVE\r\n')
    expect(acknowledgeLiveFrame).not.toHaveBeenCalled()
    for (let index = 0; index < 12 && parseCallbacks.length > 0; index += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(8)

    const replayIndex = writes.indexOf('authoritative replay')
    const resetIndex = writes.indexOf(POST_REPLAY_REATTACH_RESET)
    const liveIndex = writes.indexOf('NEWER-LIVE\r\n')
    expect(replayIndex).toBeGreaterThan(0)
    expect(resetIndex).toBeGreaterThan(replayIndex)
    expect(liveIndex).toBeGreaterThan(resetIndex)
    expect(acknowledgeLiveFrame).toHaveBeenCalledOnce()

    callbacksRef.replay?.('stalled replay')
    await flushAsyncTicks(8)
    const acknowledgeDisposedFrame = vi.fn()
    deliverTerminalDataWithDeferredCredit(acknowledgeDisposedFrame, () => {
      callbacksRef.data?.('LIVE-BEHIND-STALLED-REPLAY')
    })
    expect(acknowledgeDisposedFrame).not.toHaveBeenCalled()
    binding.dispose()
    expect(acknowledgeDisposedFrame).toHaveBeenCalledOnce()
  })

  it('drops a queued relay replay instead of retagging it for a replacement PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment()
    const transport = createMockTransport('remote:env-1@@terminal-old')
    const replayCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      replayCallback.current = callbacks.onReplayData ?? null
      return 'remote:env-1@@terminal-old'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(8)

    replayCallback.current?.('blocking replay')
    await flushAsyncTicks(8)
    replayCallback.current?.('stale queued replay')
    vi.mocked(transport.getPtyId).mockReturnValue('remote:env-1@@terminal-replacement')
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(12)

    expect(writes).not.toContain('blocking replay')
    expect(writes).not.toContain('stale queued replay')
    binding.dispose()
  })

  it('requests snapshot recovery for one oversized live frame deferred by replay', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { deliverTerminalDataWithDeferredCredit } =
      await import('@/lib/pane-manager/terminal-delivery-credit')
    const transport = createMockTransport('pty-large-live')
    const callbacksRef: {
      replay: ((data: string) => void) | null
      data: ((data: string) => void) | null
    } = { replay: null, data: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      callbacksRef.replay = callbacks.onReplayData ?? null
      callbacksRef.data = callbacks.onData ?? null
      return 'pty-large-live'
    })
    transportFactoryQueue.push(transport)
    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const binding = connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(8)
    const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
      typeof vi.fn
    >
    getMainBufferSnapshot.mockResolvedValue(null)
    getMainBufferSnapshot.mockClear()

    callbacksRef.replay?.('authoritative replay')
    await flushAsyncTicks(8)
    const oversizedLiveFrame = 'L'.repeat(512 * 1024 + 1)
    const acknowledgeDroppedFrame = vi.fn()
    deliverTerminalDataWithDeferredCredit(acknowledgeDroppedFrame, () => {
      callbacksRef.data?.(oversizedLiveFrame)
    })
    expect(acknowledgeDroppedFrame).not.toHaveBeenCalled()
    while (parseCallbacks.length > 0) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks(4)
    }
    await flushAsyncTicks(20)

    expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-large-live', {
      scrollbackRows: 5000
    })
    expect(writes.some((write) => write.startsWith('L'))).toBe(false)
    expect(acknowledgeDroppedFrame).toHaveBeenCalledOnce()
    binding.dispose()
  })

  it('does not switch renderers for Arabic output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('Arabic: السلام عليكم\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(
      'Arabic: السلام عليكم\r\n',
      expect.any(Function)
    )
  })

  it('does not switch renderers when background SGR is split across PTY chunks', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[48')
    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()

    capturedDataCallback.current?.(';2;52;52;52m codex block \x1b[0m\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
  })

  it('does not switch renderers across split background SGR PTY chunks', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[4')
    capturedDataCallback.current?.('8;2;52')
    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()

    capturedDataCallback.current?.(';52;52m codex block \x1b[0m\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
  })

  it('forces a viewport refresh for foreground Codex-style background redraws', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })

    connectPanePty(pane as never, manager as never, createDeps() as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[2J\x1b[H\x1b[48;2;52;52;52m codex block text \x1b[0m\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
    expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
  })

  it('forces a viewport refresh for foreground CJK output without CSI', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('没改什么(护城河)\r\n')

    expect(refresh).toHaveBeenCalledWith(0, 39, true)
    expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
  })

  it('schedules WebGL atlas recovery after renderer-risk foreground output parses', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const refresh = vi.fn()
    let parseCallback: (() => void) | undefined
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      parseCallback = callback
    })

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('没改什么(护城河)\r\n')

    expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    parseCallback?.()
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
    expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
  })

  it('schedules WebGL atlas recovery for Vim-style foreground alternate-screen redraws', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
      const refresh = vi.fn()
      let parseCallback: (() => void) | undefined
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.(
        '\x1b[2J\x1b[H{"name":"eepo"}\r\n\x1b[2;1H{"name":"expo"}\x1b[K'
      )

      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
      parseCallback?.()
      expect(refresh).toHaveBeenCalledWith(0, 39, true)
      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
    } finally {
      restoreNavigator()
    }
  })

  it('schedules WebGL atlas recovery when a foreground rewrite enters alternate screen', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const refresh = vi.fn()
      let parseCallback: (() => void) | undefined
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[?1049h\x1b[2J\x1b[HVim package.json')

      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
      // Why: xterm switches to the alternate buffer while parsing; the write callback observes the post-parse state.
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
      parseCallback?.()
      expect(refresh).toHaveBeenCalledWith(0, 39, true)
      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
    } finally {
      restoreNavigator()
    }
  })

  it('schedules WebGL atlas recovery when the alternate-screen enter sequence splits across chunks', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const refresh = vi.fn()
      let parseCallback: (() => void) | undefined
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      // Why: PTY reads split CSI sequences at arbitrary byte boundaries, so the enter sequence can straddle two onData chunks.
      capturedDataCallback.current?.('\x1b[?104')
      parseCallback?.()
      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()

      capturedDataCallback.current?.('9h\x1b[2J\x1b[H~\x1b[K')
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
      parseCallback?.()
      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
    } finally {
      restoreNavigator()
    }
  })

  it('schedules WebGL atlas recovery when a foreground rewrite leaves alternate screen', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
      const refresh = vi.fn()
      let parseCallback: (() => void) | undefined
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      // Vim's final frame restores the normal buffer in one chunk; the atlas must still rebuild even though the post-parse buffer reads normal.
      capturedDataCallback.current?.('\x1b[34;1H\x1b[K\x1b[34;1H\x1b[?1049l\x1b[?25h')
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'normal'
      parseCallback?.()
      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
    } finally {
      restoreNavigator()
    }
  })

  it('schedules WebGL atlas recovery when one chunk enters and exits alternate screen', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      let bufferChangeListener: (() => void) | undefined
      ;(
        pane.terminal.buffer as {
          onBufferChange?: (listener: () => void) => { dispose: () => void }
        }
      ).onBufferChange = (listener) => {
        bufferChangeListener = listener
        return { dispose: vi.fn() }
      }
      const refresh = vi.fn()
      let parseCallback: (() => void) | undefined
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      // A coalesced flush can parse enter -> draw -> exit in one write (buffer nets back to 'normal'); the switch count still marks it alternate-screen work.
      capturedDataCallback.current?.('\x1b[?1049h\x1b[2J\x1b[Hpager frame\x1b[K\x1b[?1049l')
      bufferChangeListener?.()
      bufferChangeListener?.()
      parseCallback?.()
      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
    } finally {
      restoreNavigator()
    }
  })

  it('schedules WebGL atlas recovery for real captured Vim redraw chunks split mid-sequence', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
      const refresh = vi.fn()
      let parseCallback: (() => void) | undefined
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      // Captured from a real vim session: a 1024-byte PTY read boundary cuts the cursor move \x1b[30;5H into "\x1b[30" + ";5H".
      capturedDataCallback.current?.('"rules": {\x1b[29;15H\x1b[K\x1b[30')
      parseCallback?.()
      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)

      capturedDataCallback.current?.(
        ';5H  "js-combine-iterations": "off"\r\n    }\x1b[31;6H\x1b[K\x1b[33;1H\x1b[?25h'
      )
      parseCallback?.()
      expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(2)
    } finally {
      restoreNavigator()
    }
  })

  it('does not schedule WebGL atlas recovery for ordinary foreground shell rewrites', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const refresh = vi.fn()
      let parseCallback: (() => void) | undefined
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\r\x1b[Korca % npm test')

      parseCallback?.()
      expect(refresh).toHaveBeenCalledWith(0, 39, true)
      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
    } finally {
      restoreNavigator()
    }
  })

  it('does not schedule WebGL atlas recovery for plain synchronized foreground frames', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      let parseCallback: (() => void) | undefined
      pane.terminal.write = vi.fn((_data: string, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[?2026hplain claude frame\x1b[?2026l')

      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
      parseCallback?.()
      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
    } finally {
      restoreNavigator()
    }
  })

  it('forces a viewport refresh when foreground background SGR is split across PTY chunks', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })

    connectPanePty(pane as never, manager as never, createDeps() as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[48')
    expect(refresh).not.toHaveBeenCalled()

    capturedDataCallback.current?.(';2;52;52;52m codex block text \x1b[0m\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
    expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
  })

  it('forces a viewport refresh when the foreground CSI introducer is split across PTY chunks', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })

    connectPanePty(pane as never, manager as never, createDeps() as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b')
    expect(refresh).not.toHaveBeenCalled()

    capturedDataCallback.current?.('[48;2;52;52;52m codex block text \x1b[0m\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledWith(0, 39, true)
    expect(scheduleTerminalWebglAtlasRecovery).toHaveBeenCalledTimes(1)
  })

  it('does not keep forcing viewport refresh after completed background redraws', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const refresh = vi.fn()
    const terminal = pane.terminal as typeof pane.terminal & {
      _core?: { refresh: typeof refresh }
    }
    terminal._core = { refresh }
    terminal.write = vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })

    connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('\x1b[2J\x1b[H\x1b[48;2;52;52;52m codex block text \x1b[0m\r\n')
    expect(refresh).toHaveBeenCalledWith(0, 39, true)

    refresh.mockClear()
    scheduleTerminalWebglAtlasRecovery.mockClear()
    capturedDataCallback.current?.('plain follow-up output\r\n')

    expect(refresh).not.toHaveBeenCalled()
    expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
  })

  it('forces a viewport refresh for native Windows CJK foreground output after terminal input', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)
      sendTerminalInputThroughPane(pane, '已经安装完成，软件已更新后重启。')

      capturedDataCallback.current?.('已经安装完成，软件已更新后重启。')

      expect(refresh).toHaveBeenCalledWith(0, 39, true)
    } finally {
      restoreNavigator()
    }
  })

  it('forces the native Windows CJK repaint path for foreground agent output without recent terminal input', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('已经安装完成，软件已更新后重启。')

      expect(refresh).toHaveBeenCalledWith(0, 39, true)
    } finally {
      restoreNavigator()
    }
  })

  it('does not force renderer-risk repaint for ordinary non-ASCII output', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)
      sendTerminalInputThroughPane(pane, 'abc 123 ✓')

      capturedDataCallback.current?.('abc 123 ✓')

      expect(refresh).not.toHaveBeenCalled()
      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
    } finally {
      restoreNavigator()
    }
  })

  it('applies the Windows CJK repaint path to SSH panes on Windows clients after terminal input', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      // Why: missing-glyph workaround is renderer-scoped, not PTY-scoped — SSH moves byte origin but Windows still paints locally.
      mockStoreState = {
        ...mockStoreState,
        repos: [{ id: 'repo1', connectionId: 'conn-1', displayName: 'orca' }]
      }

      const pane = createPane(1)
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)
      sendTerminalInputThroughPane(pane, '已经安装完成，软件已更新后重启。')

      capturedDataCallback.current?.('已经安装完成，软件已更新后重启。')

      expect(refresh).toHaveBeenCalledWith(0, 39, true)
    } finally {
      restoreNavigator()
    }
  })

  it('does not repaint ordinary non-ASCII output on non-Windows clients', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('abc 123 ✓')

      expect(refresh).not.toHaveBeenCalled()
      expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
    } finally {
      restoreNavigator()
    }
  })

  it('schedules a follow-up repaint for Claude-style in-place prompt redraws on native Windows', async () => {
    // Why: issue #5656/#5653 — native Windows ConPTY paints Claude's in-place prompt redraw one frame late; needs a follow-up next-frame repaint.
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      // User typed into the prompt; Claude redraws the input line in place.
      capturedDataCallback.current?.('\r\x1b[3Gzzzx\x1b[K')

      // One synchronous settle refresh + one follow-up next-frame refresh.
      expect(refresh).toHaveBeenCalledTimes(2)
      expect(refresh).toHaveBeenNthCalledWith(1, 0, 39, true)
      expect(refresh).toHaveBeenNthCalledWith(2, 0, 39, true)
    } finally {
      restoreNavigator()
    }
  })

  it('does not schedule a follow-up repaint for the Claude redraw pattern on non-Windows clients', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      // CR redraw still forces one synchronous refresh, but no native-Windows follow-up repaint is scheduled.
      capturedDataCallback.current?.('\r\x1b[3Gzzzx\x1b[K')

      expect(refresh).toHaveBeenCalledTimes(1)
      expect(refresh).toHaveBeenCalledWith(0, 39, true)
    } finally {
      restoreNavigator()
    }
  })

  it('coalesces forced foreground refreshes when WebGL is live', async () => {
    const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const synchronousRefresh = vi.fn()
      const debouncedRefresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof synchronousRefresh }
        refresh: typeof debouncedRefresh
      }
      terminal._core = { refresh: synchronousRefresh }
      terminal.refresh = debouncedRefresh
      terminal.write = vi.fn((_data: string, callback?: () => void) => callback?.())
      const manager = createManager(1)
      manager.hasWebglRenderer.mockReturnValue(true)

      connectPanePty(pane as never, manager as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\r\x1b[3Gzzzx\x1b[K')

      expect(debouncedRefresh).toHaveBeenCalledWith(0, 39)
      expect(synchronousRefresh).not.toHaveBeenCalled()
    } finally {
      restoreNavigator()
    }
  })

  it('drains a post-submit synchronized frame on the fast path when its end marker arrives late', async () => {
    // Why (STA-1041): a submit-opened DEC 2026 frame must drain fast (~16ms) by open time, even when ConPTY splits its close past the 150ms window.
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      // Enter submits; the synchronized repaint frame opens immediately after.
      sendTerminalInputThroughPane(pane, '\r')
      const repaintBody = 'opencode repaint '.repeat(200)
      expect(repaintBody.length).toBeGreaterThan(2048)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
      // The frame body holds, then its hold-safety fallback drains it.
      vi.advanceTimersByTime(40)
      pane.terminal.write.mockClear()

      // ConPTY delivers the closing chunk well past the 150ms redraw window.
      vi.advanceTimersByTime(300)
      const endChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
      expect(endChunk.length).toBeGreaterThan(2048)
      capturedDataCallback.current?.(endChunk)

      // Fast path: the latency-sensitive coalesce window is ~16ms, not 1000ms.
      vi.advanceTimersByTime(20)
      expect(pane.terminal.write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      restoreNavigator()
    }
  })

  it('keeps coalescing a synchronized frame end with no recent input behind the 1s fallback', async () => {
    // Why (STA-1041): fast path is keystroke-only; a background split redraw waits the full fallback so Windows never rasterizes the transient cursor.
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      // No terminal input: this synchronized redraw is not submit-driven.
      const repaintBody = 'opencode repaint '.repeat(200)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
      // Let the frame body drain via its 250ms hold-safety fallback before isolating the closing chunk.
      vi.advanceTimersByTime(300)
      pane.terminal.write.mockClear()

      const endChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
      capturedDataCallback.current?.(endChunk)

      // The fast 16ms window must NOT flush a background split-restore frame.
      vi.advanceTimersByTime(20)
      expect(pane.terminal.write).not.toHaveBeenCalled()

      // The full coalesce fallback still drains it so the frame is never lost.
      vi.advanceTimersByTime(1000)
      expect(pane.terminal.write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      restoreNavigator()
    }
  })

  it('does not leak the interactive latch across a same-chunk close+open to a stale frame', async () => {
    // Why: a same-chunk close+open re-evaluates the new frame from its own open time so it can't inherit the prior frame's fast path.
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      // Load-bearing: Enter opens an INTERACTIVE frame that stays OPEN — the leak precondition, since the buggy set-branch is gated on !active.
      sendTerminalInputThroughPane(pane, '\r')
      const repaintBody = 'opencode repaint '.repeat(200)
      expect(repaintBody.length).toBeGreaterThan(2048)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
      // Move past the 400ms interactive window without closing the frame, so any new frame now classifies non-interactive.
      vi.advanceTimersByTime(500)
      pane.terminal.write.mockClear()

      // One chunk closes the prior frame and opens a new one ~500ms post-keystroke; the recompute must judge the new frame non-interactive from its own open time.
      capturedDataCallback.current?.(`\x1b[?2026l\x1b[?2026h${repaintBody}`)
      vi.advanceTimersByTime(40)
      pane.terminal.write.mockClear()

      // The new frame's split restore + end marker arrive in a later chunk.
      const staleEndChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
      expect(staleEndChunk.length).toBeGreaterThan(2048)
      capturedDataCallback.current?.(staleEndChunk)

      // The fast ~16ms window must NOT flush this stale non-interactive frame.
      vi.advanceTimersByTime(20)
      expect(pane.terminal.write).not.toHaveBeenCalled()

      // Only the full 1s coalesce fallback drains it, restoring the protection.
      vi.advanceTimersByTime(1000)
      expect(pane.terminal.write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      restoreNavigator()
    }
  })

  it('coalesces a second synchronized frame that opens after the window with no keystroke', async () => {
    // Why: the second frame opens after the interactive window, so its start is judged independently and stays on the 1s fallback.
    const restoreNavigator = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    try {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      // Frame 1: submit-driven and interactive; opens and closes cleanly.
      sendTerminalInputThroughPane(pane, '\r')
      const repaintBody = 'opencode repaint '.repeat(200)
      expect(repaintBody.length).toBeGreaterThan(2048)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}\x1b[?2026l`)
      vi.advanceTimersByTime(40)

      // Move past the 400ms window with no further keystroke, then open frame 2.
      vi.advanceTimersByTime(500)
      capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
      vi.advanceTimersByTime(40)
      pane.terminal.write.mockClear()

      // Frame 2's split cursor restore + end marker arrive in a later chunk.
      const secondEndChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
      capturedDataCallback.current?.(secondEndChunk)

      // The fast ~16ms window must NOT flush this non-interactive second frame.
      vi.advanceTimersByTime(20)
      expect(pane.terminal.write).not.toHaveBeenCalled()

      // The full 1s coalesce fallback drains it so the frame is never lost.
      vi.advanceTimersByTime(1000)
      expect(pane.terminal.write).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      restoreNavigator()
    }
  })

  it('keeps terminal UI drawing glyphs on the active renderer', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)

    capturedDataCallback.current?.('⠋ Working ├─ file.ts █ progress \uE0B0 prompt\r\n')

    expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(
      '⠋ Working ├─ file.ts █ progress \uE0B0 prompt\r\n',
      expect.any(Function)
    )
  })

  it('reattaches via daemon sessionId when an in-session PTY is live', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-local-detached' }]
      },
      settings: {
        ...mockStoreState.settings
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-local-detached' })
    )
    expect(transport.attach).not.toHaveBeenCalled()
    await flushAsyncTicks()
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'pty-local-detached')
  })

  it('attaches remote runtime PTY handles instead of creating a replacement terminal', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.attach.mockImplementation(({ callbacks }: { callbacks?: ConnectCallbacks }) => {
      transport.getPtyId.mockReturnValue('remote:env-1@@terminal-1')
      callbacks?.onReplayData?.('restored remote prompt $ ')
      callbacks?.onConnect?.()
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'remote:terminal-1' }]
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-1'
      }
    } as StoreState

    const pane = createPane(2)
    pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => callback?.())
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()

    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'remote:terminal-1' })
    )
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'remote:env-1@@terminal-1')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:env-1@@terminal-1')
    await vi.waitFor(() =>
      expect(window.api.pty.reportRendererSerializerReady).toHaveBeenCalledWith(
        'remote:env-1@@terminal-1'
      )
    )
  })

  it('reports remote renderer readiness only after delayed restore output is parsed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    let remoteCallbacks: ConnectCallbacks | undefined
    transport.attach.mockImplementation(({ callbacks }: { callbacks?: ConnectCallbacks }) => {
      transport.getPtyId.mockReturnValue('remote:env-1@@terminal-delayed')
      remoteCallbacks = callbacks
    })
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'remote:terminal-delayed' }]
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-1'
      }
    } as StoreState
    const pane = createPane(2)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

    connectPanePty(pane as never, createManager(2) as never, createDeps() as never)
    await flushAsyncTicks()
    expect(window.api.pty.reportRendererSerializerReady).not.toHaveBeenCalled()

    remoteCallbacks?.onReplayData?.('delayed restored prompt $ ')
    remoteCallbacks?.onConnect?.()
    await vi.waitFor(() => expect(parseCallbacks.length).toBeGreaterThan(0))
    expect(window.api.pty.reportRendererSerializerReady).not.toHaveBeenCalled()

    for (let step = 0; step < 10; step += 1) {
      await vi.waitFor(() => expect(parseCallbacks.length).toBeGreaterThan(0))
      parseCallbacks.shift()?.()
      await flushAsyncTicks()
      if (vi.mocked(window.api.pty.reportRendererSerializerReady!).mock.calls.length > 0) {
        break
      }
    }
    expect(writes.join('')).toContain('delayed restored prompt $ ')
    await vi.waitFor(() =>
      expect(window.api.pty.reportRendererSerializerReady).toHaveBeenCalledWith(
        'remote:env-1@@terminal-delayed'
      )
    )
  })

  it('cold-spawns slept remote runtime PTYs instead of reattaching the preserved handle', async () => {
    const { connectPanePty } = await import('./pty-connection')
    enableActiveRuntimeEnvironment('env-1')
    const restoredPtyId = 'remote:env-1@@terminal-1'
    const freshPtyId = 'remote:env-1@@terminal-2'
    const transport = createMockTransport(freshPtyId)
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(
      async ({ callbacks, sessionId }: Record<string, unknown>) => {
        capturedDataCallback.current = (callbacks as ConnectCallbacks | undefined)?.onData ?? null
        if (sessionId) {
          throw new Error('slept remote runtime PTYs must not reattach by sessionId')
        }
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
          | ((ptyId: string) => void)
          | undefined
        onPtySpawn?.(freshPtyId)
        const connectCallbacks = callbacks as ConnectCallbacks | undefined
        connectCallbacks?.onReplayData?.('shell ready\r\n')
        connectCallbacks?.onConnect?.()
        return freshPtyId
      }
    )
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId }]
      },
      ptyIdsByTabId: {
        'tab-1': []
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-1',
        agentCmdOverrides: {}
      },
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    } as StoreState

    const pane = createPane(1)
    pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => callback?.())
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: restoredPtyId }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)
    capturedDataCallback.current?.('shell ready\r\n')
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.attach).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-session-1'",
        launchAgent: 'codex',
        launchConfig: {
          agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
          agentArgs: '--dangerously-bypass-approvals-and-sandbox',
          agentEnv: {}
        },
        launchToken: expect.stringMatching(new RegExp(`^${UUID_RE}$`)),
        env: expect.objectContaining({
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'tab-1',
          ORCA_WORKTREE_ID: 'wt-1',
          ORCA_WORKSPACE_ID: 'wt-1',
          ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
        })
      })
    )
    expect(transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ sessionId: expect.any(String) })
    )
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, null)
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', restoredPtyId)
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, freshPtyId)
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', freshPtyId)
    expect(window.api.pty.reportRendererSerializerReady).toHaveBeenCalledWith(freshPtyId)
    expect(transport.sendInput).not.toHaveBeenCalled()
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
  })

  it('does not let a restored encoded PTY override the current worktree owner', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'remote:env-1@@terminal-1' }]
      },
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/tmp/wt-1',
            displayName: 'feat/notis',
            runtimeOwnerEnvironmentId: 'env-2'
          }
        ]
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-2'
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('env-2', expect.any(Object))
    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'remote:env-1@@terminal-1' })
    )
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:env-1@@terminal-1')
  })

  it('routes a paired-web mirrored pane through its session-scoped HUB owner', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const tabId = 'web-terminal-host-tab'
    const ptyId = 'remote:hub-web@@terminal-1'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: tabId, ptyId }] },
      ptyIdsByTabId: { [tabId]: [ptyId] },
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/srv/wt-1',
            hostId: 'local'
          }
        ]
      },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }]
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        tabId,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: ptyId }
      }) as never
    )

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-web', expect.any(Object))
    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    expect(transport.attach).toHaveBeenCalledWith(expect.objectContaining({ existingPtyId: ptyId }))
  })

  it('uses a paired-web pane owner to disambiguate duplicate HUB projections', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const tabId = 'web-terminal-host-tab'
    const ptyId = 'remote:hub-b@@terminal-1'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: tabId, ptyId }] },
      worktreesByRepo: {
        repo1: [
          { id: 'wt-1', repoId: 'repo1', path: '/srv/wt-1', hostId: 'local' },
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/srv/wt-1',
            hostId: 'ssh:private-target',
            runtimeOwnerEnvironmentId: 'hub-b'
          }
        ]
      }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({
        tabId,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: ptyId }
      }) as never
    )

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-b', expect.any(Object))
  })

  it('ignores a stale runtime PTY on an explicitly local non-web pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const ptyId = 'remote:stale-hub@@terminal-1'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
      },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
      settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'stale-hub' }
    } as StoreState

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)

    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).toHaveBeenCalled()
  })

  it('uses the focused runtime only for ownerless mixed-version publications', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/srv/wt-1' }]
      },
      repos: [{ id: 'repo1', connectionId: null }],
      settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'legacy-hub' }
    } as StoreState

    connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('legacy-hub', expect.any(Object))
  })

  it('runs an inline setup terminal locally instead of failing its host closed', async () => {
    // Regression (#9994 fallout): the branded ephemeral-setup id resolves to no worktree/repo, so
    // the strict owner resolver reported it unresolved and gave the pane the "Workspace identity is
    // ambiguous across hosts" error transport instead of a real local PTY.
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const setupWorktreeId =
      'ephemeral-setup-terminal:settings-mobile-emulator-orca-cli-skill-terminal'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { [setupWorktreeId]: [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
      },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }]
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ worktreeId: setupWorktreeId }) as never
    )

    expect(createIpcPtyTransport).toHaveBeenCalled()
    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
  })

  it('runs an inline setup terminal on the single active runtime for remote skill installs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const setupWorktreeId =
      'ephemeral-setup-terminal:settings-mobile-emulator-orca-cli-skill-terminal'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { [setupWorktreeId]: [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
      },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
      runtimeEnvironments: [{ id: 'hub-a' }],
      settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'hub-a' }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ worktreeId: setupWorktreeId }) as never
    )

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-a', expect.any(Object))
  })

  it('keeps the floating terminal local even while a runtime is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'global-floating-terminal': [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
      },
      repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
      runtimeEnvironments: [{ id: 'hub-a' }],
      settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'hub-a' }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ worktreeId: 'global-floating-terminal' }) as never
    )

    expect(createIpcPtyTransport).toHaveBeenCalled()
    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
  })

  it('routes a HUB-owned SSH PTY wake hint through the HUB without direct SSH', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const hostPtyId = 'ssh:hub-private@@pty-2'
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: hostPtyId }]
      },
      ptyIdsByTabId: { 'tab-1': [hostPtyId] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_1 },
          activeLeafId: LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_1]: hostPtyId }
        }
      },
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/srv/wt-1',
            hostId: 'ssh:hub-private',
            runtimeOwnerEnvironmentId: 'hub-env'
          }
        ]
      },
      repos: [
        {
          id: 'repo1',
          connectionId: 'hub-private',
          executionHostId: 'runtime:hub-env'
        }
      ]
    } as StoreState
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: hostPtyId }
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks()

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-env', expect.any(Object))
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: hostPtyId })
    )
    expect(transport.attach).not.toHaveBeenCalled()
    expect(window.api.ssh.connect).not.toHaveBeenCalled()
    expect(window.api.ssh.needsPassphrasePrompt).not.toHaveBeenCalled()
  })

  it('fails closed when the same SSH worktree id is projected by two HUBs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/srv/same-worktree',
            hostId: 'ssh:same-private-target',
            runtimeOwnerEnvironmentId: 'hub-a'
          },
          {
            id: 'wt-1',
            repoId: 'repo1',
            path: '/srv/same-worktree',
            hostId: 'ssh:same-private-target',
            runtimeOwnerEnvironmentId: 'hub-b'
          }
        ]
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'hub-a'
      }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ restoredPtyIdByLeafId: { [LEAF_1]: null } }) as never
    )
    await flushAsyncTicks()

    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    expect(window.api.ssh.connect).not.toHaveBeenCalled()
    expect(window.api.ssh.needsPassphrasePrompt).not.toHaveBeenCalled()
  })

  it('fails a missing paired-client owner closed instead of creating a local PTY', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      worktreesByRepo: {
        repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/srv/stale-worktree' }]
      },
      runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }],
      runtimeEnvironmentCatalogHydrated: true,
      settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'hub-a' }
    } as StoreState

    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ restoredPtyIdByLeafId: { [LEAF_1]: null } }) as never
    )
    await flushAsyncTicks()

    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    expect(window.api.ssh.connect).not.toHaveBeenCalled()
  })

  it('spawns fresh PTYs through the worktree owner runtime when focus differs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createMockTransport('remote:owner-runtime@@terminal-1')
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: null }]
      },
      repos: [
        {
          id: 'repo1',
          connectionId: null,
          displayName: 'orca',
          executionHostId: 'runtime:owner-runtime'
        }
      ],
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'focused-runtime'
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      startup: {
        command: "codex '--profile' 'recipe'",
        launchAgent: 'codex',
        launchConfig: { agentArgs: '--profile recipe', agentEnv: {} },
        agentArgsOverride: '--profile recipe'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith(
      'owner-runtime',
      expect.any(Object)
    )
    expect(createdTransportOptions[0]?.cwdFallback).toBeUndefined()
    expect(createdTransportOptions[0]?.agentArgsOverride).toBe('--profile recipe')
    expect(transport.connect).toHaveBeenCalled()
  })

  it('spawns fresh PTYs locally for explicitly local worktrees while a runtime is focused', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createMockTransport('pty-local-1')
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: null }]
      },
      repos: [
        {
          id: 'repo1',
          connectionId: null,
          displayName: 'orca',
          executionHostId: 'local'
        }
      ],
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'focused-runtime'
      }
    } as StoreState

    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    expect(createIpcPtyTransport).toHaveBeenCalled()
    expect(createdTransportOptions[0]?.cwdFallback).toBe('worktree')
    expect(transport.connect).toHaveBeenCalled()
  })

  it('prints a terminal notice when the startup cwd fell back to the workspace root', async () => {
    const { connectPanePty, STARTUP_CWD_FALLBACK_NOTICE } = await import('./pty-connection')
    const transport = createMockTransport('pty-fallback')
    transport.connect.mockResolvedValueOnce({
      id: 'pty-fallback',
      startupCwdFallback: { kind: 'worktree', cwd: '/tmp/wt-1' }
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: null }]
      }
    } as StoreState

    const pane = createPane(2)
    const { writes } = captureCallbackTerminalWrites(pane)

    connectPanePty(pane as never, createManager(2) as never, createDeps() as never)
    await flushAsyncTicks()

    expect(writes).toContain(STARTUP_CWD_FALLBACK_NOTICE)
  })

  it('attaches restored remote PTYs for later split panes instead of spawning host tabs', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const existingTransport = createMockTransport('remote:env-1@@terminal-1')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'remote:env-1@@terminal-1' }]
      },
      settings: {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: 'env-1'
      }
    } as StoreState

    const paneTransports = new Map([[1, existingTransport]])
    const pane = createPane(2)
    const manager = createManager(2)
    const deps = createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: {
        [LEAF_2]: 'remote:env-1@@terminal-2'
      },
      paneTransportsRef: { current: paneTransports }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'remote:env-1@@terminal-2' })
    )
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:env-1@@terminal-2')
  })

  it('persists a restarted pane PTY id and uses it on the next remount', async () => {
    const { connectPanePty } = await import('./pty-connection')

    const restartedTransport = createMockTransport()
    let spawnedPtyId: string | null = null
    restartedTransport.connect.mockImplementation(async () => {
      spawnedPtyId = 'pty-restarted'
      const opts = createdTransportOptions[0]
      ;(opts.onPtySpawn as (ptyId: string) => void)('pty-restarted')
      return 'pty-restarted'
    })
    transportFactoryQueue.push(restartedTransport)

    const restartPane = createPane(1)
    const restartManager = createManager(1)
    const restartDeps = createDeps({
      paneTransportsRef: { current: new Map([[99, createMockTransport('another-pane-pty')]]) }
    })

    connectPanePty(restartPane as never, restartManager as never, restartDeps as never)
    await flushAsyncTicks()

    expect(spawnedPtyId).toBe('pty-restarted')
    expect(restartDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted')

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-restarted' }]
      },
      settings: {
        ...mockStoreState.settings
      }
    }

    const remountTransport = createMockTransport()
    transportFactoryQueue.push(remountTransport)
    const remountPane = createPane(1)
    const remountManager = createManager(1)
    const remountDeps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'pty-restarted' }
    })

    connectPanePty(remountPane as never, remountManager as never, remountDeps as never)

    expect(remountTransport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-restarted' })
    )
    expect(remountTransport.attach).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(remountDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted')
  })

  // Why: BEL (0x07) is the attention signal — onBell raises worktree/tab/pane unread + an OS notification.
  it('wires onBell to raise worktree unread, tab unread, and OS notification', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler) {
      throw new Error('Expected onBell to be registered')
    }

    bellHandler()

    expect(deps.markWorktreeUnread).toHaveBeenCalledTimes(1)
    expect(deps.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.markTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'terminal-bell',
        paneKey: makePaneKey('tab-1', LEAF_1)
      })
    )
  })

  it('does not raise pane attention on bell when the experimental setting is disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: false
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler) {
      throw new Error('Expected onBell to be registered')
    }

    bellHandler()

    expect(deps.markWorktreeUnread).toHaveBeenCalledTimes(1)
    expect(deps.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.markTerminalPaneUnread).not.toHaveBeenCalled()
  })

  // Kill switch on (default): no byte parsers; pane policy is the PTY's single fact consumer (terminal-side-effect-authority.md).
  describe('with main side-effect authority on', () => {
    const SIDE_EFFECT_PARSER_CALLBACKS = [
      'onTitleChange',
      'onBell',
      'onAgentBecameIdle',
      'onAgentBecameWorking',
      'onAgentExited'
    ] as const

    function enableMainAuthority(): void {
      mockStoreState.settings = {
        ...mockStoreState.settings,
        terminalMainSideEffectAuthority: true
      }
    }

    it('omits byte-parser callbacks from the local transport options', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)

      expect(createdTransportOptions[0]).toBeDefined()
      for (const callback of SIDE_EFFECT_PARSER_CALLBACKS) {
        expect(createdTransportOptions[0]?.[callback]).toBeUndefined()
      }
      // Lifecycle callbacks stay on the transport; only side-effect parsing moves to the fact consumer.
      expect(createdTransportOptions[0]?.onPtySpawn).toBeTypeOf('function')
      expect(createdTransportOptions[0]?.onPtyExit).toBeTypeOf('function')
    })

    it('keeps byte-parser callbacks on remote-runtime transports', async () => {
      enableMainAuthority()
      enableActiveRuntimeEnvironment()
      const { connectPanePty } = await import('./pty-connection')
      const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('env-1', expect.any(Object))
      for (const callback of SIDE_EFFECT_PARSER_CALLBACKS) {
        expect(createdTransportOptions[0]?.[callback]).toBeTypeOf('function')
      }
    })

    it('consumes pty:sideEffect facts with the live-path policy after spawn', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const handler = await import('./terminal-side-effect-facts-handler')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      vi.useFakeTimers()

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()
      connectPanePty(pane as never, manager as never, deps as never)

      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
      onPtySpawn('pty-fact-1')

      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-1',
        seq: 10,
        facts: [
          { kind: 'title', normalizedTitle: 'Codex working', rawTitle: 'Codex working' },
          { kind: 'bell' }
        ]
      })

      expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Codex working')
      expect(deps.markWorktreeUnread).toHaveBeenCalledTimes(1)
      expect(deps.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
      expect(deps.dispatchNotification).not.toHaveBeenCalled()
      vi.advanceTimersByTime(250)
      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'terminal-bell',
          paneKey: makePaneKey('tab-1', LEAF_1)
        })
      )
    })

    it('stops consuming facts after the pane binding is disposed', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const handler = await import('./terminal-side-effect-facts-handler')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      const deps = createDeps()
      const binding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        deps as never
      )
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
      onPtySpawn('pty-fact-2')

      binding.dispose()
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-2',
        seq: 1,
        facts: [{ kind: 'bell' }]
      })

      expect(deps.markWorktreeUnread).not.toHaveBeenCalled()
      expect(deps.markTerminalTabUnread).not.toHaveBeenCalled()
    })

    it('schedules the completion notification for genuine working→idle facts', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const handler = await import('./terminal-side-effect-facts-handler')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      vi.useFakeTimers()

      const deps = createDeps()
      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
      onPtySpawn('pty-fact-genuine')

      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-genuine',
        seq: 1,
        facts: [
          { kind: 'title', normalizedTitle: '⠋ Codex working', rawTitle: '⠋ Codex working' },
          { kind: 'agent-working' }
        ]
      })
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-genuine',
        seq: 2,
        facts: [
          { kind: 'title', normalizedTitle: '* Codex done', rawTitle: '* Codex done' },
          { kind: 'agent-idle', title: '* Codex done' }
        ]
      })
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent-task-complete' })
      )
    })

    it('clears state without completion attention for stale-derived facts', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const handler = await import('./terminal-side-effect-facts-handler')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      vi.useFakeTimers()

      const deps = createDeps()
      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
      onPtySpawn('pty-fact-stale')

      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-stale',
        seq: 1,
        facts: [
          { kind: 'title', normalizedTitle: '⠋ Codex working', rawTitle: '⠋ Codex working' },
          { kind: 'agent-working' }
        ]
      })
      // Main's unthrottled 3s stale-title rewrite for a merely-paused agent.
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-stale',
        seq: 2,
        facts: [
          {
            kind: 'title',
            normalizedTitle: 'Codex',
            rawTitle: 'Codex',
            staleWorkingTitleClear: true
          },
          { kind: 'agent-idle', title: 'Codex', staleWorkingTitleClear: true }
        ]
      })

      // The cleared title still lands; the cache timer is cleared.
      expect(deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'Codex')
      expect(deps.setCacheTimerStartedAt).toHaveBeenLastCalledWith(
        makePaneKey('tab-1', LEAF_1),
        null
      )
      // But no task-complete notification or unread attention is scheduled.
      vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)
      expect(deps.dispatchNotification).not.toHaveBeenCalled()
      expect(deps.markWorktreeUnread).not.toHaveBeenCalled()
      expect(deps.markTerminalPaneUnread).not.toHaveBeenCalled()
    })

    it('drops the agent status from a command-finished fact like the byte path did', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const handler = await import('./terminal-side-effect-facts-handler')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.agentStatusByPaneKey = {
        [paneKey]: {
          paneKey,
          state: 'done',
          prompt: 'hi',
          updatedAt: 1000,
          stateStartedAt: 1000,
          agentType: 'codex',
          stateHistory: []
        }
      }

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
      onPtySpawn('pty-fact-133')

      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-133',
        seq: 1,
        facts: [{ kind: 'command-finished', exitCode: 130 }]
      })

      expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
      expect(mockStoreState.removeAgentStatus).not.toHaveBeenCalled()
    })

    it('routes pr-link facts to the worktree PR observer', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const handler = await import('./terminal-side-effect-facts-handler')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
      onPtySpawn('pty-fact-pr')

      const link = {
        url: 'https://github.com/acme/orca/pull/42',
        slug: { owner: 'acme', repo: 'orca' },
        number: 42
      }
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-pr',
        seq: 1,
        facts: [{ kind: 'pr-link', link }]
      })

      expect(mockStoreState.observeTerminalGitHubPullRequestLink).toHaveBeenCalledWith('wt-1', link)
    })

    it('does not byte-scan PR links or OSC 133 — facts are the only consumer', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-authority-bytes'
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.agentStatusByPaneKey = {
        [paneKey]: {
          paneKey,
          state: 'done',
          prompt: 'hi',
          updatedAt: 1000,
          stateStartedAt: 1000,
          agentType: 'codex',
          stateHistory: []
        }
      }

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('Created https://github.com/acme/orca/pull/42\r\n')
      capturedDataCallback.current?.('\x1b]133;D;130\x07prompt $ ')

      expect(mockStoreState.observeTerminalGitHubPullRequestLink).not.toHaveBeenCalled()
      expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    })

    it('seeds and settles Command Code status from command-code facts', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const handler = await import('./terminal-side-effect-facts-handler')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      vi.useFakeTimers()
      const paneKey = makePaneKey('tab-1', LEAF_1)

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
      onPtySpawn('pty-fact-cc')

      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-cc',
        seq: 1,
        facts: [{ kind: 'command-code-working', prompt: 'say hi' }]
      })
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'working',
        prompt: 'say hi',
        agentType: 'command-code'
      })

      // Why: done is a hint — the settle timer stays in pane policy so it can consult the live status row before completing.
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-cc',
        seq: 2,
        facts: [{ kind: 'command-code-done', prompt: 'say hi' }]
      })
      vi.advanceTimersByTime(1499)
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({ state: 'working' })
      vi.advanceTimersByTime(1)
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'done',
        prompt: 'say hi',
        agentType: 'command-code'
      })
    })

    it('keeps Command Code working when a working fact lands before the done settles', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const handler = await import('./terminal-side-effect-facts-handler')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      vi.useFakeTimers()
      const paneKey = makePaneKey('tab-1', LEAF_1)

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
      onPtySpawn('pty-fact-cc-repaint')

      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-cc-repaint',
        seq: 1,
        facts: [{ kind: 'command-code-working', prompt: 'Run a slow command' }]
      })
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-cc-repaint',
        seq: 2,
        facts: [{ kind: 'command-code-done', prompt: 'Run a slow command' }]
      })
      vi.advanceTimersByTime(1000)
      // An active repaint within the settle window cancels the pending done.
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-fact-cc-repaint',
        seq: 3,
        facts: [{ kind: 'command-code-working', prompt: 'Run a slow command' }]
      })
      vi.advanceTimersByTime(2000)

      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'working',
        prompt: 'Run a slow command',
        agentType: 'command-code'
      })
    })

    it('does not byte-scan Command Code output — facts are the only consumer', async () => {
      enableMainAuthority()
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-authority-cc-bytes'
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        createDeps({ startup: { command: 'command-code --trust' } }) as never
      )
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('# Command Code v0.27.2\r\n')
      capturedDataCallback.current?.('❯ Fix the spinner\r\n\x1b[35m✻ Thinking...\x1b[0m')

      expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    })

    it('honors the persisted kill switch for panes bound before settings hydrate', async () => {
      // Pre-hydration: settings not loaded but kill switch persisted off — pane registers byte parsers, not a fact consumer.
      mockStoreState.settings = null
      ;(window.api as unknown as Record<string, unknown>).settings = {
        getSync: vi.fn(() => ({ terminalMainSideEffectAuthority: false }))
      }
      const { connectPanePty } = await import('./pty-connection')
      const handler = await import('./terminal-side-effect-facts-handler')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      const deps = createDeps()
      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)

      for (const callback of SIDE_EFFECT_PARSER_CALLBACKS) {
        expect(createdTransportOptions[0]?.[callback]).toBeTypeOf('function')
      }
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
      onPtySpawn('pty-prehydration')

      // No fact consumer registered: channel batches are dropped.
      handler._dispatchTerminalSideEffectBatchForTest({
        ptyId: 'pty-prehydration',
        seq: 1,
        facts: [{ kind: 'bell' }]
      })
      expect(deps.markWorktreeUnread).not.toHaveBeenCalled()

      // Hydration with switch still off: byte parsing stays the single consumer — one BEL marks unread once.
      mockStoreState.settings = { terminalMainSideEffectAuthority: false }
      notifyStoreSubscribers()
      const onBell = createdTransportOptions[0]?.onBell as () => void
      onBell()
      expect(deps.markWorktreeUnread).toHaveBeenCalledTimes(1)
    })
  })

  it('lets concurrent agent-complete notifications win over terminal bell notifications', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Fix notification payloads',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Codex done',
      stateHistory: [],
      lastAssistantMessage: 'Implemented the formatter.'
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!bellHandler || !idleHandler) {
      throw new Error('Expected bell and idle handlers to be registered')
    }

    bellHandler()
    idleHandler('* Codex done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    await flushAsyncTicks()

    expect(window.api.notifications.dispatch).toHaveBeenCalledTimes(1)
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: '* Codex done',
        agentType: 'codex',
        agentLastAssistantMessage: 'Implemented the formatter.'
      })
    )
  })

  it('does not suppress terminal bell notifications when agent-complete notifications are disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!bellHandler || !idleHandler) {
      throw new Error('Expected bell and idle handlers to be registered')
    }

    bellHandler()
    idleHandler('* Codex done')
    vi.advanceTimersByTime(250)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        suppressOsNotification: true
      })
    )
  })

  it('raises terminal attention for agent completion when OS completion notifications are disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: true,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected idle handler to be registered')
    }

    idleHandler('* Codex done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey: makePaneKey('tab-1', LEAF_1),
        suppressOsNotification: true
      })
    )
  })

  it('shares one raw store subscriber for agent-complete notification settings across panes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    transportFactoryQueue.push(createMockTransport('pty-1'), createMockTransport('pty-2'))

    vi.useFakeTimers()
    const firstBinding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps() as never
    )
    const secondBinding = connectPanePty(
      createPane(2) as never,
      createManager(1) as never,
      createDeps() as never
    )
    await flushAsyncTicks()

    expect(storeSubscribers).toHaveLength(1)

    firstBinding.dispose()
    expect(storeSubscribers).toHaveLength(1)
    secondBinding.dispose()
    expect(storeSubscribers).toHaveLength(0)
  })

  it('does not dispatch generic title completions when agent-complete notifications are disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const api = (
      globalThis as unknown as {
        window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
      }
    ).window.api
    api.pty.getForegroundProcess.mockResolvedValue('codex')
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('⠋ experimental-agent-observability', '⠋ experimental-agent-observability')
    titleHandler('experimental-agent-observability', 'experimental-agent-observability')
    await flushAsyncTicks()
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('does not replay disabled generic title completions after notifications are re-enabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const inspection = createDeferred<string | null>()
    const api = (
      globalThis as unknown as {
        window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
      }
    ).window.api
    api.pty.getForegroundProcess.mockReturnValue(inspection.promise)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('⠋ experimental-agent-observability', '⠋ experimental-agent-observability')
    titleHandler('experimental-agent-observability', 'experimental-agent-observability')
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: true
      }
    }
    inspection.resolve('codex')
    await flushAsyncTicks()
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('clears title completion state when notifications are disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('Claude working', 'Claude working')
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: false
      }
    }
    notifyStoreSubscribers()
    titleHandler('Claude done', 'Claude done')
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: true
      }
    }
    notifyStoreSubscribers()
    titleHandler('Claude done', 'Claude done')
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('cancels scheduled agent completion when notifications are disabled before dispatch', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Codex done')
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: false
      }
    }
    notifyStoreSubscribers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: true
      }
    }
    notifyStoreSubscribers()
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('restores a suppressed terminal bell when disabling pending agent completion', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!bellHandler || !idleHandler) {
      throw new Error('Expected bell and idle handlers to be registered')
    }

    bellHandler()
    idleHandler('* Codex done')
    vi.advanceTimersByTime(250)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: false
      }
    }
    notifyStoreSubscribers()
    vi.advanceTimersByTime(250)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
  })

  it('requires fresh working evidence after notifications are disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!workingHandler || !idleHandler) {
      throw new Error('Expected working and idle handlers to be registered')
    }

    workingHandler()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: false
      }
    }
    notifyStoreSubscribers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: true
      }
    }
    notifyStoreSubscribers()
    idleHandler('* Codex done')
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('requires fresh working evidence when notifications start disabled then re-enable', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!workingHandler || !idleHandler) {
      throw new Error('Expected working and idle handlers to be registered')
    }

    workingHandler()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      notifications: {
        ...mockStoreState.settings.notifications,
        agentTaskComplete: true
      }
    }
    notifyStoreSubscribers()
    idleHandler('* Codex done')
    vi.advanceTimersByTime(1_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('dispatches agent-task-complete for generic Codex spinner titles after process identity is confirmed', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const api = (
      globalThis as unknown as {
        window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
      }
    ).window.api
    api.pty.getForegroundProcess.mockResolvedValue('codex')
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('⠋ experimental-agent-observability', '⠋ experimental-agent-observability')
    titleHandler('experimental-agent-observability', 'experimental-agent-observability')
    await flushAsyncTicks()

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: 'experimental-agent-observability',
      paneKey: makePaneKey('tab-1', LEAF_1)
    })
    expect(window.api.pty.inspectProcess).toHaveBeenCalledWith('pty-codex')
  })

  it('does not dispatch generic spinner completions when process inspection finds no agent', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-shell')
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const api = (
      globalThis as unknown as {
        window: { api: { pty: { getForegroundProcess: ReturnType<typeof vi.fn> } } }
      }
    ).window.api
    api.pty.getForegroundProcess.mockResolvedValue('zsh')
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('⠋ experimental-agent-observability', '⠋ experimental-agent-observability')
    titleHandler('experimental-agent-observability', 'experimental-agent-observability')
    await flushAsyncTicks()

    vi.advanceTimersByTime(16_000)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('dispatches agent-task-complete from recognized hook completion events', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage: string
        }) => void)
      | undefined
    if (!statusHandler) {
      throw new Error('Expected onAgentStatus to be registered')
    }

    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Done.'
    })
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey: makePaneKey('tab-1', LEAF_1)
      })
    )
  })

  it('suppresses PTY-owned Codex auto-approved permission statuses before status or notification work', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: {
        agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
        agentEnv: {}
      }
    }

    const launchConfig = {
      agentCommand: 'codex',
      agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
      agentEnv: {}
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      startup: {
        command: 'codex',
        launchConfig,
        launchToken: 'launch-yolo',
        launchAgent: 'codex'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'waiting'
          prompt: string
          agentType: 'codex'
          toolName: string
          toolInput: string
        }) => void)
      | undefined
    if (!statusHandler) {
      throw new Error('Expected onAgentStatus to be registered')
    }

    statusHandler({
      state: 'waiting',
      prompt: 'auto-approved permission',
      agentType: 'codex',
      toolName: 'exec_command',
      toolInput: 'git status'
    })

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    expect(deps.dispatchNotification).not.toHaveBeenCalled()
  })

  it('suppresses synthetic Codex auto-approved permission titles before title work', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: {
        agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
        agentEnv: {}
      }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps({
      startup: {
        command: 'codex',
        launchConfig: {
          agentCommand: 'codex',
          agentArgs: YOLO_TUI_AGENT_ARGS.codex ?? '',
          agentEnv: {}
        },
        launchToken: 'launch-yolo',
        launchAgent: 'codex'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }
    mockStoreState.getAgentLaunchConfigForStatusMetadata.mockClear()

    titleHandler('Codex - action required', 'Codex - action required')

    expect(mockStoreState.getAgentLaunchConfigForStatusMetadata).toHaveBeenCalledTimes(1)
    expect(deps.setRuntimePaneTitle).not.toHaveBeenCalled()
    expect(deps.updateTabTitle).not.toHaveBeenCalled()
    expect(manager.setPaneGpuRendering).not.toHaveBeenCalled()
  })

  it('does not resolve launch config for ordinary title changes', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }
    mockStoreState.getAgentLaunchConfigForStatusMetadata.mockClear()

    for (let index = 0; index < 100; index += 1) {
      titleHandler(`build output ${index}`, `build output ${index}`)
    }

    expect(mockStoreState.getAgentLaunchConfigForStatusMetadata).not.toHaveBeenCalled()
  })

  it('preserves synthetic Codex manual permission titles', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: {
        agentArgs: '',
        agentEnv: {}
      }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps({
      startup: {
        command: 'codex',
        launchConfig: {
          agentCommand: 'codex',
          agentArgs: '',
          agentEnv: {}
        },
        launchToken: 'launch-manual',
        launchAgent: 'codex'
      }
    })

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('Codex - action required', 'Codex - action required')

    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Codex - action required')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Codex - action required')
  })

  it('normalizes Pi-compatible remote titles to authoritative OMP launch identity', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-omp')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', launchAgent: 'omp' }]
    }
    mockStoreState.runtimePaneTitlesByTabId = { 'tab-1': { 1: '\u280b Pi' } }

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }
    titleHandler('\u280b Pi', '\u280b Pi')
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, '\u280b OMP')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', '\u280b OMP')
    titleHandler('π: tmp', 'π: tmp')
    expect(deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'OMP ready')
    expect(deps.updateTabTitle).toHaveBeenLastCalledWith('tab-1', 'OMP ready')

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: { state: 'working'; prompt: string; agentType: 'pi' }) => void)
      | undefined
    if (!statusHandler) {
      throw new Error('Expected onAgentStatus to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'fix the remote title',
      agentType: 'pi'
    })

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'fix the remote title',
        agentType: 'omp'
      },
      '\u280b OMP',
      undefined,
      { connectionId: null }
    )

    mockStoreState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
    }
    statusHandler({
      state: 'working',
      prompt: 'keep the remote title',
      agentType: 'pi'
    })

    expect(mockStoreState.setAgentStatus).toHaveBeenLastCalledWith(
      makePaneKey('tab-1', LEAF_1),
      {
        state: 'working',
        prompt: 'keep the remote title',
        agentType: 'omp'
      },
      '\u280b OMP',
      undefined,
      { connectionId: null }
    )
  })

  it('keeps GPU rendering enabled for OMP titles whose cwd is Gemini', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-omp-gemini-cwd')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.tabsByWorktree = {
      'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', launchAgent: 'omp' }]
    }

    const pane = createPane(1)
    const manager = createManager(1)
    manager.getActivePane.mockReturnValue({ id: 1 })
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    manager.setPaneGpuRendering.mockClear()

    titleHandler('\u280b Pi', '\u280b π: gemini')

    expect(manager.setPaneGpuRendering).toHaveBeenCalledTimes(1)
    expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, true)
    expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, '\u280b OMP')
    expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', '\u280b OMP')
  })

  it('leaves local IPC OSC 9999 status ownership in the main runtime', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-local')
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createdTransportOptions[0]?.onAgentStatus).toBeUndefined()
  })

  it('leaves SSH IPC OSC 9999 status ownership in the main runtime', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-ssh')
    transportFactoryQueue.push(transport)
    mockStoreState = {
      ...mockStoreState,
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
    } as StoreState

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    expect(createdTransportOptions[0]?.onAgentStatus).toBeUndefined()
  })

  it('lets delayed hook completion notifications win over concurrent terminal bells', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!statusHandler || !bellHandler) {
      throw new Error('Expected hook status and bell handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Done.'
    })
    bellHandler()

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    vi.advanceTimersByTime(
      AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey: makePaneKey('tab-1', LEAF_1),
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          prompt: 'finish the implementation',
          agentType: 'codex',
          lastAssistantMessage: 'Done.'
        })
      })
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
  })

  it('restores a suppressed terminal bell when a delayed hook completion resumes work', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('tab-pty')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.ptyIdsByTabId = { 'tab-1': ['tab-pty'] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'tab-pty' }

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!statusHandler || !bellHandler) {
      throw new Error('Expected hook status and bell handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Done.'
    })
    bellHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('restores a suppressed terminal bell when a delayed hook completion resumes via title tracking', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'codex'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    if (!statusHandler || !bellHandler || !workingHandler) {
      throw new Error('Expected hook status, bell, and working handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'codex'
    })
    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'codex',
      lastAssistantMessage: 'Milestone complete.'
    })
    bellHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )

    workingHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('restores a suppressed terminal bell when the pending agent completion is canceled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    if (!bellHandler || !idleHandler || !workingHandler) {
      throw new Error('Expected bell, idle, and working handlers to be registered')
    }

    bellHandler()
    idleHandler('* Codex done')
    workingHandler()
    vi.advanceTimersByTime(250)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'terminal-bell' })
    )
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
  })

  it('cancels a title task-complete notification when the agent resumes before quiet', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const workingHandler = createdTransportOptions[0]?.onAgentBecameWorking as
      | (() => void)
      | undefined
    if (!idleHandler || !workingHandler) {
      throw new Error('Expected idle and working handlers to be registered')
    }

    idleHandler('* Codex done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 1)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )

    workingHandler()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )

    idleHandler('* Codex done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: '* Codex done',
      paneKey: makePaneKey('tab-1', LEAF_1)
    })
  })

  // Why: a DOM keydown signals "user is here"; raw xterm onData is lower-level (can include terminal replies/control bytes).
  it('clears tab and worktree unread on real keydown', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    pane.terminal.element = createPaneContainer()
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const keydown = new Event('keydown')
    Object.defineProperty(keydown, 'key', { value: 'a' })
    Object.defineProperty(keydown, 'repeat', { value: false })
    Object.defineProperty(keydown, 'ctrlKey', { value: false })
    Object.defineProperty(keydown, 'metaKey', { value: false })
    Object.defineProperty(keydown, 'shiftKey', { value: false })
    ;(pane.terminal.element as EventTarget).dispatchEvent(keydown)

    expect(deps.clearTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.clearTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.clearWorktreeUnread).toHaveBeenCalledWith('wt-1')
    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('clears tab, pane, and worktree unread on plain Escape keydown', async () => {
    // Why: plain Escape is real input (\x1b) — a genuine "user is here" signal; the interrupt-intent early return must not skip the unread clears.
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    pane.terminal.element = createPaneContainer()
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const keydown = new Event('keydown')
    Object.defineProperty(keydown, 'key', { value: 'Escape' })
    Object.defineProperty(keydown, 'repeat', { value: false })
    Object.defineProperty(keydown, 'ctrlKey', { value: false })
    Object.defineProperty(keydown, 'metaKey', { value: false })
    Object.defineProperty(keydown, 'altKey', { value: false })
    Object.defineProperty(keydown, 'shiftKey', { value: false })
    ;(pane.terminal.element as EventTarget).dispatchEvent(keydown)

    expect(deps.clearTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(deps.clearTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.clearWorktreeUnread).toHaveBeenCalledWith('wt-1')
  })

  it('does not clear pane attention from raw onData after a bell', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler || !onDataHandler) {
      throw new Error('expected bell and onData handlers to be registered')
    }

    bellHandler()
    ;(onDataHandler as (data: string) => void)('a')

    expect(deps.markTerminalPaneUnread).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    expect(deps.clearTerminalPaneUnread).not.toHaveBeenCalled()
    expect(transport.sendInput).toHaveBeenCalledWith('a')
  })

  // Why: xterm auto-replies during replay must not count as user interaction, or a BELed pane would self-dismiss unseen.
  it('does not clear unread when onData fires during replay', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)
    const manager = createManager(1)
    const replayingPanesRef = { current: new Map<number, number>([[1, 1]]) }
    const deps = createDeps({ replayingPanesRef })

    connectPanePty(pane as never, manager as never, deps as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('\x1b[?1;2c')

    expect(deps.clearTerminalTabUnread).not.toHaveBeenCalled()
    expect(deps.clearWorktreeUnread).not.toHaveBeenCalled()
  })

  // Why: on a stale-codex pane (pending account-switch restart), onData bytes must not count as user interaction; production also blocks sendInput here.
  it('does not clear unread when onData fires on a stale codex pane', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-codex-stale')
    transportFactoryQueue.push(transport)
    // isCodexPaneStale reads codexRestartNoticeByPtyId; seed a restart notice to trigger the stale branch.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1', ptyId: 'pty-codex-stale' }]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-codex-stale']
      },
      codexRestartNoticeByPtyId: {
        'pty-codex-stale': { previousAccountLabel: 'A', nextAccountLabel: 'B' }
      }
    }

    const pane = createPane(1)
    let onDataHandler: ((data: string) => void) | null = null
    pane.terminal.onData = vi.fn(((handler: (data: string) => void) => {
      onDataHandler = handler
      return { dispose: vi.fn() }
    }) as typeof pane.terminal.onData)

    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    if (!onDataHandler) {
      throw new Error('expected onData handler to be registered')
    }
    ;(onDataHandler as (data: string) => void)('a')

    expect(deps.clearTerminalTabUnread).not.toHaveBeenCalled()
    expect(deps.clearWorktreeUnread).not.toHaveBeenCalled()
    // Stale-codex input is also blocked from reaching the transport.
    expect(transport.sendInput).not.toHaveBeenCalled()
  })

  it('replays attach buffer for deferred SSH reattach and clears stale tab session metadata', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('leaf-session')
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      const id = opts.sessionId ?? 'pty-new'
      transport.getPtyId.mockReturnValue(id)
      return { id, replay: 'restored-ssh-output' }
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'tab-level-stale-session' }
    }

    const pane = createPane(1)
    const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
    const manager = createManager(1)
    const deps = createDeps({
      restoredLeafId: LEAF_1,
      restoredPtyIdByLeafId: { [LEAF_1]: 'leaf-session' }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    const settlePaneSerializer = vi.mocked(window.api.pty.settlePaneSerializer)
    expect(parseCallbacks.length).toBeGreaterThan(0)
    expect(settlePaneSerializer).not.toHaveBeenCalled()
    for (let step = 0; step < 20 && settlePaneSerializer.mock.calls.length === 0; step += 1) {
      parseCallbacks.shift()?.()
      await flushAsyncTicks()
    }
    expect(settlePaneSerializer).toHaveBeenCalledWith(expect.any(String), 1)

    const api = (
      globalThis as unknown as {
        window: {
          api: {
            ssh: { connect: ReturnType<typeof vi.fn> }
            pty: { signal: ReturnType<typeof vi.fn> }
          }
        }
      }
    ).window.api
    expect(api.ssh.connect).toHaveBeenCalledWith({ targetId: 'conn-1' })
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'leaf-session' })
    )
    expect(mockStoreState.removeDeferredSshSessionId).toHaveBeenCalledWith('tab-1')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'leaf-session')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'leaf-session')
    // Why: the relay's replay buffer holds full history, so clear xterm before writing to avoid duplicating prior-session content.
    expect(writes).toContain('\x1b[2J\x1b[3J\x1b[H')
    expect(writes).toContain('restored-ssh-output')
    expect(writes).toContain(POST_REPLAY_REATTACH_RESET)
    expect(api.pty.signal).toHaveBeenCalledWith('leaf-session', 'SIGWINCH')
  })

  it('does not auto-reconnect after a user cancels deferred SSH passphrase auth', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      sshConnectionStates: new Map([['conn-1', { status: 'disconnected' }]]),
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'saved-session' }
    }

    const api = (
      globalThis as unknown as {
        window: {
          api: {
            ssh: {
              connect: ReturnType<typeof vi.fn>
              needsPassphrasePrompt: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    ).window.api
    api.ssh.needsPassphrasePrompt.mockResolvedValue(true)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(3)

    mockStoreState.sshConnectionStates = new Map([['conn-1', { status: 'connecting' }]])
    notifyStoreSubscribers()
    mockStoreState.sshConnectionStates = new Map([['conn-1', { status: 'disconnected' }]])
    notifyStoreSubscribers()
    await flushAsyncTicks(10)

    expect(api.ssh.connect).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshSessionId).not.toHaveBeenCalled()
    expect(mockStoreState.removeDeferredSshReconnectTarget).not.toHaveBeenCalled()
  })

  it('spawns a fresh PTY when a deferred SSH session expired', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts) => {
      if (opts.sessionId) {
        opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: expired-session')
        return undefined
      }
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      onPtySpawn?.('fresh-ssh-pty')
      return 'fresh-ssh-pty'
    })
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'expired-session' }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
    expect(transport.connect).toHaveBeenCalledTimes(2)
    expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'expired-session')
    expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'expired-session')
    expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'fresh-ssh-pty')
    expect(deps.updateTabPtyId).toHaveBeenCalledWith('tab-1', 'fresh-ssh-pty')
  })

  it('clears the pending serializer when disposed before deferred SSH expiry resolves', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const reattach = createDeferred<undefined>()
    const transport = createMockTransport()
    transport.connect.mockImplementation(
      (opts: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
        if (opts.sessionId) {
          opts.callbacks?.onError?.('SSH_SESSION_EXPIRED: expired-session')
          return reattach.promise
        }
        return Promise.resolve('fresh-ssh-pty')
      }
    )
    transportFactoryQueue.push(transport)

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
      repos: [{ id: 'repo1', connectionId: 'conn-1' }],
      deferredSshReconnectTargets: ['conn-1'],
      deferredSshSessionIdsByTabId: { 'tab-1': 'expired-session' }
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    const binding = connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(10)
    binding.dispose()
    reattach.resolve(undefined)
    await flushAsyncTicks(10)

    expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(
      makePaneKey('tab-1', LEAF_1),
      1
    )
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  // Why: wires the REAL useNotificationDispatch (not a stub) so deleting the producer breaks the IPC assertion — the user-facing contract.
  it('dispatches agent-task-complete on working→idle and raises tab/worktree unread', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    // Why: invoke useNotificationDispatch's body directly (useCallback is pure memo); relies on the file-level vi.mock('react') useCallback pass-through.
    const realDispatchNotification = useNotificationDispatch('wt-1')
    const dispatchNotification = vi.fn((event) => realDispatchNotification(event))
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Fix notification payloads',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      // Why: snapshot agent must match the live completion title ('* Claude done') to be reused; a mismatch is dropped as stale — see use-notification-dispatch.test.ts.
      agentType: 'claude',
      paneKey,
      terminalTitle: '* Claude done',
      stateHistory: [],
      toolName: 'Edit',
      toolInput: 'src/main/ipc/notifications.ts',
      lastAssistantMessage: 'Implemented the formatter.',
      interrupted: false
    }
    mockStoreState.worktreesByRepo.repo2 = [
      { id: 'wt-2', repoId: 'repo2', path: '/tmp/wt-2', displayName: 'feat/other' }
    ]
    mockStoreState.repos.push({ id: 'repo2', connectionId: null, displayName: 'docs' })
    mockStoreState.activeWorktreeId = 'wt-2'

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    vi.useFakeTimers()
    idleHandler('* Claude done')

    expect(mockStoreState.markWorktreeUnread).not.toHaveBeenCalled()
    expect(mockStoreState.markTerminalTabUnread).not.toHaveBeenCalled()
    expect(dispatchNotification).not.toHaveBeenCalled()

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    await flushAsyncTicks()

    expect(dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: '* Claude done',
      paneKey
    })
    expect(mockStoreState.markWorktreeUnread).toHaveBeenCalledWith('wt-1')
    expect(mockStoreState.markTerminalTabUnread).toHaveBeenCalledWith('tab-1')
    expect(mockStoreState.markTerminalPaneUnread).toHaveBeenCalledWith(paneKey)
    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        worktreeId: 'wt-1',
        repoLabel: 'orca',
        worktreeLabel: 'feat/notis',
        hasMultipleActiveRepos: true,
        terminalTitle: '* Claude done',
        agentType: 'claude',
        agentState: 'done',
        agentPrompt: 'Fix notification payloads',
        agentToolName: 'Edit',
        agentToolInput: 'src/main/ipc/notifications.ts',
        agentLastAssistantMessage: 'Implemented the formatter.',
        agentInterrupted: false
      })
    )
  })

  it('ignores title-only idle while fresh hook status is still working', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'still thinking',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      agentType: 'pi',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('/var/folders/false-idle-title')

    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(deps.setCacheTimerStartedAt).not.toHaveBeenCalledWith(paneKey, expect.any(Number))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('allows an explicit idle title from a different agent than fresh hook status', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'previous agent state',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      agentType: 'pi',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Claude cross-agent done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith({
      source: 'agent-task-complete',
      terminalTitle: '* Claude cross-agent done',
      paneKey
    })
    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('ignores an explicit idle title while fresh hook identity is unknown', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'still working without a known agent identity',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      agentType: 'unknown',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('Claude Code done')

    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(deps.setCacheTimerStartedAt).not.toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('ignores a Pi idle title while compatible OMP hook status is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'OMP is still working',
      updatedAt: Date.now() - 60_000,
      stateStartedAt: Date.now() - 60_000,
      agentType: 'omp',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('Pi ready')

    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('preserves permission-title cursor and cache side effects through authoritative hook done', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'waiting',
      prompt: 'approve the tool call',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'done'
          prompt: string
          agentType: 'claude'
          lastAssistantMessage: string
        }) => void)
      | undefined
    if (!idleHandler || !statusHandler) {
      throw new Error('Expected idle and hook status handlers to be registered')
    }

    idleHandler('Claude Code permission')

    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(deps.setCacheTimerStartedAt).not.toHaveBeenCalled()
    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )

    statusHandler({
      state: 'done',
      prompt: 'approve the tool call',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })

    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, expect.any(Number))
  })

  it('preserves a genuine hook completion after suppressing an earlier idle title', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    vi.useFakeTimers()
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'still working',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'done'
          prompt: string
          agentType: 'claude'
          lastAssistantMessage: string
        }) => void)
      | undefined
    if (!titleHandler || !idleHandler || !statusHandler) {
      throw new Error('Expected title, idle, and hook status handlers to be registered')
    }

    titleHandler('Claude working', 'Claude working')
    titleHandler('Claude done', 'Claude done')
    idleHandler('Claude done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).not.toHaveBeenCalled()

    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })
    notifyStoreSubscribers()
    expect(deps.setCacheTimerStartedAt).not.toHaveBeenCalledWith(paneKey, expect.any(Number))
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        paneKey,
        agentStatusSnapshot: expect.objectContaining({
          state: 'done',
          agentType: 'claude',
          lastAssistantMessage: 'Done.'
        })
      })
    )
    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, expect.any(Number))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
    expect(storeSubscribers).toHaveLength(1)
  })

  it('applies accepted hook side effects when every completion alert consumer is disabled', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-hook')
    transportFactoryQueue.push(transport)
    enableActiveRuntimeEnvironment()
    mockStoreState.ptyIdsByTabId = { 'tab-1': ['pty-hook'] }
    mockStoreState.terminalLayoutsByTabId!['tab-1'].ptyIdsByLeafId = { [LEAF_1]: 'pty-hook' }
    vi.useFakeTimers()
    mockStoreState.settings = {
      ...mockStoreState.settings,
      experimentalTerminalAttention: false,
      notifications: {
        enabled: true,
        agentTaskComplete: false,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundPath: null
      }
    }
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    const statusHandler = createdTransportOptions[0]?.onAgentStatus as
      | ((payload: {
          state: 'working' | 'done'
          prompt: string
          agentType: 'claude'
          lastAssistantMessage?: string
        }) => void)
      | undefined
    if (!idleHandler || !statusHandler) {
      throw new Error('Expected idle and hook status handlers to be registered')
    }

    statusHandler({
      state: 'working',
      prompt: 'finish the implementation',
      agentType: 'claude'
    })
    idleHandler('Claude done')

    expect(deps.setCacheTimerStartedAt).not.toHaveBeenCalledWith(paneKey, expect.any(Number))
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )

    statusHandler({
      state: 'done',
      prompt: 'finish the implementation',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).not.toHaveBeenCalled()
    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, expect.any(Number))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it.each([
    {
      name: 'delivers confirmed process exit despite the same stale working hook row',
      hookUpdateBeforeDispatch: 'none'
    },
    {
      name: 'delivers confirmed process exit after a same-turn working hook refresh',
      hookUpdateBeforeDispatch: 'same-turn'
    },
    {
      name: 'delivers confirmed process exit after same-turn hook identity becomes known',
      hookUpdateBeforeDispatch: 'same-turn-known-agent'
    },
    {
      name: 'cancels confirmed process exit delivery when a newer working hook row arrives',
      hookUpdateBeforeDispatch: 'new-turn'
    }
  ] as const)('$name', async ({ hookUpdateBeforeDispatch }) => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-crashed-codex')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const crashedTurnStartedAt = Date.now()
      const initialAgentType =
        hookUpdateBeforeDispatch === 'same-turn-known-agent' ? 'unknown' : 'codex'
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: 'crash before done hook',
        updatedAt: crashedTurnStartedAt,
        stateStartedAt: crashedTurnStartedAt,
        agentType: initialAgentType,
        paneKey,
        stateHistory: []
      }
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const titleHandler = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!titleHandler) {
        throw new Error('Expected onTitleChange to be registered')
      }

      titleHandler('Codex working', 'Codex working')
      await vi.advanceTimersByTimeAsync(2_500)
      getForegroundProcess.mockResolvedValue(null)
      await vi.advanceTimersByTimeAsync(1_800)
      if (hookUpdateBeforeDispatch !== 'none') {
        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'working',
          prompt:
            hookUpdateBeforeDispatch === 'new-turn'
              ? 'new turn after the prior process exited'
              : 'same turn hook detail refresh',
          updatedAt: Date.now(),
          stateStartedAt:
            hookUpdateBeforeDispatch === 'new-turn' ? Date.now() : crashedTurnStartedAt,
          agentType: 'codex',
          paneKey,
          stateHistory: []
        }
        notifyStoreSubscribers()
      }
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

      const expectedNotification = {
        source: 'agent-task-complete',
        terminalTitle: 'codex',
        paneKey,
        agentCompletionSource: 'process-exit'
      }
      if (hookUpdateBeforeDispatch === 'new-turn') {
        expect(deps.dispatchNotification).not.toHaveBeenCalledWith(expectedNotification)
      } else {
        expect(deps.dispatchNotification).toHaveBeenCalledWith(expectedNotification)
      }
      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
      transport.sendInput.mockClear()
      sendTerminalInputThroughPane(pane, '\x1b[I')
      sendTerminalInputThroughPane(pane, '\x7f')
      expect(transport.sendInput).toHaveBeenCalledTimes(2)
      expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x1b[I')
      expect(transport.sendInput).toHaveBeenLastCalledWith('\x7f')
    } finally {
      restoreUserAgent()
    }
  })

  it('drops an exited agent completion when a replacement agent hook row is active', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-replaced-codex')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
    getForegroundProcess.mockResolvedValue('codex')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    if (!titleHandler) {
      throw new Error('Expected onTitleChange to be registered')
    }

    titleHandler('Codex working', 'Codex working')
    await vi.advanceTimersByTimeAsync(2_500)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'replacement agent turn',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }
    getForegroundProcess.mockResolvedValue('claude')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent-task-complete' })
    )
    expect(pane.terminal.write).not.toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )

    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'replacement agent turn',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }
    titleHandler('Claude done', 'Claude done')
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

    expect(deps.dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: 'Claude done',
        paneKey
      })
    )
  })

  it('drops confirmed idle exit when a different hook owner appears between null samples', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-replaced-codex')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    // Why: pin the ±10% poll jitter to nominal so the 2nd null sample can't confirm exit before the replacement owner is set.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      // Why: one timer advance can start multiple reads; gate the 2nd+ null sample until the replacement hook owner is installed.
      let idleMode = false
      let nullSamplesStarted = 0
      let releaseConfirmingNullSample: (() => void) | undefined
      const confirmingNullSampleGate = new Promise<void>((resolve) => {
        releaseConfirmingNullSample = resolve
      })
      getForegroundProcess.mockImplementation(async () => {
        if (!idleMode) {
          return 'codex'
        }
        nullSamplesStarted += 1
        if (nullSamplesStarted >= 2) {
          await confirmingNullSampleGate
        }
        return null
      })
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const titleHandler = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!titleHandler || !idleHandler) {
        throw new Error('Expected title and idle handlers to be registered')
      }

      titleHandler('Codex working', 'Codex working')
      await vi.advanceTimersByTimeAsync(2_500)
      idleMode = true
      for (let attempts = 0; nullSamplesStarted < 1; attempts += 1) {
        if (attempts >= 10) {
          throw new Error('Expected the first idle process inspection')
        }
        await vi.advanceTimersToNextTimerAsync()
      }
      // Why: let the first null sample apply pendingProcessExitAgent before the replacement owner is installed.
      await flushAsyncTicks()

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: 'replacement agent turn',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'claude',
        paneKey,
        stateHistory: []
      }
      releaseConfirmingNullSample?.()
      // Ignore cursor resets from setup so this assertion only covers the replacement idle event.
      pane.terminal.write.mockClear()
      idleHandler('Claude done')
      await vi.advanceTimersByTimeAsync(800)
      await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)

      expect(deps.dispatchNotification).not.toHaveBeenCalledWith(
        expect.objectContaining({ source: 'agent-task-complete' })
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        RESET_TERMINAL_CURSOR_STYLE,
        expect.any(Function)
      )
    } finally {
      // Why: an assertion failure above must not leave Math.random pinned for later tests.
      randomSpy.mockRestore()
    }
  })

  it('preserves replacement-agent title side effects through the process replacement veto', async () => {
    const { dispatchAgentHookTerminalLifecycle } = await import('./agent-hook-terminal-lifecycle')
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-replaced-codex')
    transportFactoryQueue.push(transport)
    vi.useFakeTimers()
    const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
    getForegroundProcess.mockResolvedValue('codex')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks()
    const titleHandler = createdTransportOptions[0]?.onTitleChange as
      | ((title: string, rawTitle: string) => void)
      | undefined
    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!titleHandler || !idleHandler) {
      throw new Error('Expected title and idle handlers to be registered')
    }

    titleHandler('Codex working', 'Codex working')
    await vi.advanceTimersByTimeAsync(2_500)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'working',
      prompt: 'replacement agent turn',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'claude',
      paneKey,
      stateHistory: []
    }
    idleHandler('Claude done')
    getForegroundProcess.mockResolvedValue('claude')
    await vi.advanceTimersByTimeAsync(1_000)

    dispatchAgentHookTerminalLifecycle(paneKey, {
      state: 'done',
      prompt: 'replacement agent turn',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })

    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(paneKey, expect.any(Number))
    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('resets renderer cursor style when an agent becomes idle', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Codex done')

    expect(pane.terminal.write).toHaveBeenCalledWith(
      RESET_TERMINAL_CURSOR_STYLE,
      expect.any(Function)
    )
  })

  it('resets stale keyboard state when a native Windows agent becomes idle', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!idleHandler) {
        throw new Error('Expected onAgentBecameIdle to be registered')
      }

      idleHandler('* Codex done')

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
    } finally {
      restoreUserAgent()
    }
  })

  it('keeps SSH agent idle reset cursor-only on Windows clients', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      mockStoreState = {
        ...mockStoreState,
        repos: [{ id: 'repo1', connectionId: 'conn-1' }],
        sshConnectionStates: new Map([['conn-1', { status: 'connected' }]])
      } as StoreState
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      if (!idleHandler) {
        throw new Error('Expected onAgentBecameIdle to be registered')
      }

      idleHandler('* Codex done')

      expect(pane.terminal.write).toHaveBeenCalledWith(
        RESET_TERMINAL_CURSOR_STYLE,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
      transport.sendInput.mockClear()
      sendTerminalInputThroughPane(pane, '\x1b[I')
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
    } finally {
      restoreUserAgent()
    }
  })

  it.each([
    {
      name: 'WSL',
      configure: (): void => {
        mockStoreState.tabsByWorktree = {
          'wt-1': [{ id: 'tab-1', ptyId: null, shellOverride: 'wsl.exe' }]
        }
      }
    },
    {
      name: 'remote runtime',
      configure: (): void => {
        mockStoreState.repos = [
          {
            id: 'repo1',
            connectionId: null,
            displayName: 'orca',
            executionHostId: 'runtime:owner-runtime'
          }
        ]
      }
    }
  ])(
    'keeps $name focus reports and idle reset remote-safe on Windows clients',
    async ({ configure }) => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        configure()
        const pane = createPane(1)
        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

        const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
          | ((title: string) => void)
          | undefined
        if (!idleHandler) {
          throw new Error('Expected onAgentBecameIdle to be registered')
        }
        idleHandler('* Codex done')

        expect(pane.terminal.write).toHaveBeenCalledWith(
          RESET_TERMINAL_CURSOR_STYLE,
          expect.any(Function)
        )
        transport.sendInput.mockClear()
        sendTerminalInputThroughPane(pane, '\x1b[I')
        expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
      } finally {
        restoreUserAgent()
      }
    }
  )

  it('resets stale keyboard state when native Windows hook status reaches done', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: 'ship it',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      notifyStoreSubscribers()
      expect(pane.terminal.write).not.toHaveBeenCalled()

      const doneStatus = {
        state: 'done',
        prompt: 'ship it',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      mockStoreState.agentStatusByPaneKey[paneKey] = doneStatus
      notifyStoreSubscribers()

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
        expect.any(Function)
      )
    } finally {
      restoreUserAgent()
    }
  })

  it('drops native Windows Codex focus reports while a history resume is idle', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      pane.terminal.modes.sendFocusMode = true

      connectPanePty(
        pane as never,
        createManager(1) as never,
        createDeps({
          startup: {
            command: "codex 'resume' 'codex-session-1'",
            launchAgent: 'codex',
            telemetry: {
              agent_kind: 'codex',
              launch_source: 'sidebar',
              request_kind: 'resume'
            }
          }
        }) as never
      )

      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toBeUndefined()
      transport.sendInput.mockClear()

      sendTerminalInputThroughPane(pane, '\x1b[O')
      sendTerminalInputThroughPane(pane, '\x1b[I')
      expect(transport.sendInput).not.toHaveBeenCalled()

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: 'continue the resumed session',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      notifyStoreSubscribers()

      sendTerminalInputThroughPane(pane, '\x1b[I')
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
    } finally {
      restoreUserAgent()
    }
  })

  it.each([
    {
      name: 'Claude history resume',
      launchAgent: 'claude',
      agentKind: 'claude',
      requestKind: 'resume'
    },
    {
      name: 'fresh Codex launch',
      launchAgent: 'codex',
      agentKind: 'codex',
      requestKind: 'new'
    }
  ])(
    'keeps focus reports enabled for a native Windows $name',
    async ({ launchAgent, agentKind, requestKind }) => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const pane = createPane(1)
        pane.terminal.modes.sendFocusMode = true

        connectPanePty(
          pane as never,
          createManager(1) as never,
          createDeps({
            startup: {
              command: `${launchAgent} session-command`,
              launchAgent,
              telemetry: {
                agent_kind: agentKind,
                launch_source: 'sidebar',
                request_kind: requestKind
              }
            }
          }) as never
        )

        transport.sendInput.mockClear()
        sendTerminalInputThroughPane(pane, '\x1b[O')
        sendTerminalInputThroughPane(pane, '\x1b[I')

        expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x1b[O')
        expect(transport.sendInput).toHaveBeenNthCalledWith(2, '\x1b[I')
      } finally {
        restoreUserAgent()
      }
    }
  )

  it('drops only focus reports while native Windows Codex is done and resumes them when working', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      pane.terminal.modes.sendFocusMode = true
      const doneStatus = {
        state: 'done',
        prompt: 'ship it',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      mockStoreState.agentStatusByPaneKey[paneKey] = doneStatus
      notifyStoreSubscribers()
      const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
        | ((title: string) => void)
        | undefined
      idleHandler?.('* Codex done')
      transport.sendInput.mockClear()

      sendTerminalInputThroughPane(pane, '\x1b[O')
      sendTerminalInputThroughPane(pane, '\x1b[I')
      expect(transport.sendInput).not.toHaveBeenCalled()

      sendTerminalInputThroughPane(pane, '\x7f')
      sendTerminalInputThroughPane(pane, 'x')
      expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x7f')
      expect(transport.sendInput).toHaveBeenNthCalledWith(2, 'x')
      expect(pane.terminal.modes.sendFocusMode).toBe(true)

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        ...doneStatus,
        state: 'working'
      }
      notifyStoreSubscribers()
      transport.sendInput.mockClear()

      sendTerminalInputThroughPane(pane, '\x1b[I')
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I')
      expect(pane.terminal.modes.sendFocusMode).toBe(true)

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        ...doneStatus,
        state: 'waiting'
      }
      notifyStoreSubscribers()
      transport.sendInput.mockClear()
      sendTerminalInputThroughPane(pane, '\x1b[O')
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[O')
    } finally {
      restoreUserAgent()
    }
  })

  it('keeps focus reports enabled for native Windows Cursor completion', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      pane.terminal.modes.sendFocusMode = true

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'ship it',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'cursor',
        paneKey,
        stateHistory: []
      }
      notifyStoreSubscribers()
      transport.sendInput.mockClear()

      sendTerminalInputThroughPane(pane, '\x1b[O')
      sendTerminalInputThroughPane(pane, '\x1b[I')

      expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x1b[O')
      expect(transport.sendInput).toHaveBeenNthCalledWith(2, '\x1b[I')
      expect(pane.terminal.modes.sendFocusMode).toBe(true)
    } finally {
      restoreUserAgent()
    }
  })

  it('unsubscribes the native Windows done reset watcher on pane dispose', async () => {
    const restoreUserAgent = temporarilySetNavigatorUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    )
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    try {
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      const binding = connectPanePty(pane as never, manager as never, deps as never)
      binding.dispose()
      pane.terminal.write.mockClear()

      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'done',
        prompt: 'ship it',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        agentType: 'codex',
        paneKey,
        stateHistory: []
      }
      notifyStoreSubscribers()

      expect(pane.terminal.write).not.toHaveBeenCalled()
    } finally {
      restoreUserAgent()
    }
  })

  it('queues the idle cursor reset behind hidden agent output', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      capturedDataCallback.current = callbacks.onData ?? null
      return 'pty-id'
    })
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({
      isVisibleRef: { current: false }
    })

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(6)
    vi.useFakeTimers()

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!capturedDataCallback.current || !idleHandler) {
      throw new Error('Expected PTY data and idle handlers to be registered')
    }

    capturedDataCallback.current('\x1b[6 q')
    idleHandler('* Codex done')

    expect(pane.terminal.write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(pane.terminal.write).toHaveBeenCalledWith(`\x1b[6 q${RESET_TERMINAL_CURSOR_STYLE}`)
  })

  it('waits briefly for delayed agent status before dispatching task-complete', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Codex done')
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()

    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Use delayed hook status in notification',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Codex done',
      stateHistory: [],
      lastAssistantMessage: 'Delayed status arrived.'
    }

    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    await flushAsyncTicks()

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: '* Codex done',
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'Use delayed hook status in notification',
        agentLastAssistantMessage: 'Delayed status arrived.'
      })
    )
  })

  it('waits past the grace delay when the assistant message arrives shortly after it', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Codex done')
    vi.advanceTimersByTime(250)
    await flushAsyncTicks()
    expect(window.api.notifications.dispatch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Use the late hook status in notification',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Codex done',
      stateHistory: [],
      lastAssistantMessage: 'Late status arrived.'
    }
    notifyStoreSubscribers()
    await flushAsyncTicks()
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS - 350)
    await flushAsyncTicks()

    expect(window.api.notifications.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent-task-complete',
        terminalTitle: '* Codex done',
        agentType: 'codex',
        agentState: 'done',
        agentPrompt: 'Use the late hook status in notification',
        agentLastAssistantMessage: 'Late status arrived.'
      })
    )
  })

  it('does not use stale agent status from an earlier turn in task-complete notifications', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Previous task that must not leak',
      updatedAt: Date.now() - 15_000,
      stateStartedAt: Date.now() - 20_000,
      agentType: 'codex',
      paneKey,
      terminalTitle: '* Codex done',
      stateHistory: [],
      lastAssistantMessage: 'Old response'
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
      | ((title: string) => void)
      | undefined
    if (!idleHandler) {
      throw new Error('Expected onAgentBecameIdle to be registered')
    }

    idleHandler('* Codex done')
    vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    await flushAsyncTicks()

    const dispatchArgs = (window.api.notifications.dispatch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown> | undefined
    if (!dispatchArgs) {
      throw new Error('Expected notification dispatch')
    }
    expect(dispatchArgs).toMatchObject({
      source: 'agent-task-complete',
      worktreeId: 'wt-1',
      terminalTitle: '* Codex done'
    })
    expect('agentPrompt' in dispatchArgs).toBe(false)
    expect('agentLastAssistantMessage' in dispatchArgs).toBe(false)
    expect('agentType' in dispatchArgs).toBe(false)
  })

  it('does not attach agent fields to terminal-bell notifications', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { useNotificationDispatch } = await vi.importActual<typeof UseNotificationDispatchModule>(
      './use-notification-dispatch'
    )
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const dispatchNotification = useNotificationDispatch('wt-1')
    const paneKey = makePaneKey('tab-1', LEAF_1)
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      state: 'done',
      prompt: 'Should not leak into BEL',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'codex',
      paneKey,
      stateHistory: []
    }

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps({ dispatchNotification })

    connectPanePty(pane as never, manager as never, deps as never)

    const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
    if (!bellHandler) {
      throw new Error('Expected onBell to be registered')
    }

    vi.useFakeTimers()
    bellHandler()
    vi.advanceTimersByTime(250)

    const dispatchArgs = (window.api.notifications.dispatch as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Record<string, unknown> | undefined
    if (!dispatchArgs) {
      throw new Error('Expected notification dispatch')
    }
    expect(dispatchArgs.source).toBe('terminal-bell')
    expect('agentType' in dispatchArgs).toBe(false)
    expect('agentState' in dispatchArgs).toBe(false)
    expect('agentPrompt' in dispatchArgs).toBe(false)
    expect('agentToolName' in dispatchArgs).toBe(false)
    expect('agentToolInput' in dispatchArgs).toBe(false)
    expect('agentLastAssistantMessage' in dispatchArgs).toBe(false)
    expect('agentInterrupted' in dispatchArgs).toBe(false)
  })

  // Why: agent-row removal belongs to process/PTY lifecycle, not title reversion, so interrupts can't disappear the activity row.
  it('clears the cache timer without removing agent status when the title tracker sees exit', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)

    const pane = createPane(1)
    const manager = createManager(1)
    const deps = createDeps()

    connectPanePty(pane as never, manager as never, deps as never)

    const agentExitedHandler = createdTransportOptions[0]?.onAgentExited as (() => void) | undefined
    if (!agentExitedHandler) {
      throw new Error('Expected onAgentExited to be registered')
    }

    agentExitedHandler()

    expect(deps.setCacheTimerStartedAt).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1), null)
    expect(deps.onAgentExitedRef.current).toHaveBeenCalledWith(LEAF_1)
    expect(mockStoreState.removeAgentStatus).not.toHaveBeenCalled()
  })

  describe('reconcileIfSessionDead', () => {
    it('closes a split pane bound to a dead local session (same teardown as onExit)', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      // Why: clear the freshly-split early-return guard so onExit reaches the close branch (established, used split pane).
      capturedDataCallback.current?.('shell prompt')

      binding.reconcileIfSessionDead(new Set(['pty-pane-1']))

      expect(manager.closePane).toHaveBeenCalledWith(2)
    })

    it('closes a split pane when targeted liveness says its local session is missing', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const hasPty = vi.fn(async () => false)

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      capturedDataCallback.current?.('shell prompt')

      binding.reconcileIfSessionMissing(hasPty)
      await flushAsyncTicks()

      expect(hasPty).toHaveBeenCalledWith('pty-pane-2')
      expect(manager.closePane).toHaveBeenCalledWith(2)
    })

    it('does not close when targeted liveness is live or unknown', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      binding.reconcileIfSessionMissing(vi.fn(async () => true))
      binding.reconcileIfSessionMissing(vi.fn(async () => null))
      await flushAsyncTicks()

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('does not apply a stale targeted liveness result after reattach', async () => {
      const { connectPanePty } = await import('./pty-connection')
      let resolveHasPty: (value: boolean) => void = () => {
        throw new Error('hasPty promise resolver was not initialized')
      }
      const hasPty = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveHasPty = resolve
          })
      )
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      binding.reconcileIfSessionMissing(hasPty)
      transport.getPtyId.mockReturnValue('pty-pane-2-reattached')
      resolveHasPty(false)
      await flushAsyncTicks()

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('does NOT tear down a newborn pane when the snapshot was requested before it bound', async () => {
      // Why (regression): a snapshot requested before the spawn bound cannot prove the fresh ptyId dead (boundAt wiring).
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      // Why: clear the freshly-split early-return guard so the only remaining protection is the freshness guard under test.
      capturedDataCallback.current?.('shell prompt')
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')

      // Record boundAt via the spawn chokepoint; bracket it with a real timestamp.
      const beforeSpawn = performance.now()
      onPtySpawn?.('pty-pane-2')

      // requestedAt < boundAt: stale snapshot can't prove the fresh pane dead.
      binding.reconcileIfSessionDead(new Set(['pty-pane-1']), beforeSpawn - 1)

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('tears down the pane when the snapshot was requested after it bound', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      // Why: clear the freshly-split early-return guard so onExit reaches close.
      capturedDataCallback.current?.('shell prompt')
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')

      onPtySpawn?.('pty-pane-2')
      const afterSpawn = performance.now()

      // requestedAt > boundAt: the snapshot postdates the bind, so absence is real.
      binding.reconcileIfSessionDead(new Set(['pty-pane-1']), afterSpawn + 1)

      expect(manager.closePane).toHaveBeenCalledWith(2)
    })

    it('routes the last pane through onPtyExitRef when its session is dead', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-1')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()

      const binding = connectPanePty(createPane(1) as never, manager as never, deps as never)

      // The last pane reattaches to the tab's persisted ptyId ('tab-pty').
      binding.reconcileIfSessionDead(new Set(['some-other-live']))

      expect(deps.onPtyExitRef.current).toHaveBeenCalledWith('tab-pty')
      expect(manager.closePane).not.toHaveBeenCalled()
    })

    it('is a no-op when the bound session is still live', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      binding.reconcileIfSessionDead(new Set(['pty-pane-1', 'pty-pane-2']))

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('is a no-op for remote: web-runtime ids', async () => {
      const { connectPanePty } = await import('./pty-connection')
      enableActiveRuntimeEnvironment('env-1')
      const transport = createMockTransport('remote:env-1:pane-2')
      transport.getConnectionId.mockReturnValue(null)
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      binding.reconcileIfSessionDead(new Set())

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('is a no-op for SSH/non-local ids (non-null connectionId)', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transport.getConnectionId.mockReturnValue('ssh-target-1')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      binding.reconcileIfSessionDead(new Set())

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('respects suppression: a suppressed dead session keeps the pane mounted', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        consumeSuppressedPtyExit: vi.fn(() => true),
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      binding.reconcileIfSessionDead(new Set(['pty-pane-1']))

      expect(deps.consumeSuppressedPtyExit).toHaveBeenCalledWith('pty-pane-2')
      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('still closes the replacement PTY after a suppressed restart rebinds the pane', async () => {
      // Why (regression): the exit guard is scoped to the exiting ptyId, not a one-shot boolean, so a rebound replacement's later real exit still tears down.
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      // First exit is suppressed (intentional restart); later exits are real.
      const consumeSuppressedPtyExit = vi
        .fn<(ptyId: string) => boolean>()
        .mockImplementationOnce(() => true)
        .mockImplementation(() => false)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        consumeSuppressedPtyExit,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      connectPanePty(createPane(2) as never, manager as never, deps as never)
      capturedDataCallback.current?.('shell prompt')
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined

      // Suppressed exit of the original PTY: pane stays mounted.
      onPtyExit?.('pty-pane-2')
      expect(manager.closePane).not.toHaveBeenCalled()

      // Restart rebinds the pane to a new live PTY; its later real exit must not be ignored by a stale guard.
      transport.getPtyId.mockReturnValue('pty-pane-2-restarted')
      onPtyExit?.('pty-pane-2-restarted')

      expect(manager.closePane).toHaveBeenCalledTimes(1)
      expect(manager.closePane).toHaveBeenCalledWith(2)
    })

    it('does not act on a stale id after a reattach changed the bound id', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)

      // Reattach between snapshot and apply: snapshot marked the OLD id dead, but getPtyId now returns the new live id.
      transport.getPtyId.mockReturnValue('pty-pane-2-reattached')
      binding.reconcileIfSessionDead(new Set(['pty-pane-1', 'pty-pane-2-reattached']))

      expect(manager.closePane).not.toHaveBeenCalled()
      expect(deps.onPtyExitRef.current).not.toHaveBeenCalled()
    })

    it('closes a split pane exactly once across reconcile + a racing real exit', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      capturedDataCallback.current?.('shell prompt')
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined
      expect(onPtyExit).toBeTypeOf('function')

      binding.reconcileIfSessionDead(new Set(['pty-pane-1']))
      // A racing real/synthetic pty:exit for the SAME id must not close twice.
      onPtyExit?.('pty-pane-2')

      expect(manager.closePane).toHaveBeenCalledTimes(1)
      expect(manager.closePane).toHaveBeenCalledWith(2)
    })

    it('closes a genuinely-dead non-suppressed pane once (not misread as suppressed)', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-pane-2')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      // consumeSuppressedPtyExit always returns false for this genuinely-dead id.
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        consumeSuppressedPtyExit: vi.fn(() => false),
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })

      const binding = connectPanePty(createPane(2) as never, manager as never, deps as never)
      capturedDataCallback.current?.('shell prompt')
      const onPtyExit = createdTransportOptions[0]?.onPtyExit as
        | ((ptyId: string) => void)
        | undefined

      binding.reconcileIfSessionDead(new Set(['pty-pane-1']))
      onPtyExit?.('pty-pane-2')

      // Observable outcome: single close, pane was treated as dead (closed).
      expect(manager.closePane).toHaveBeenCalledTimes(1)
      expect(manager.closePane).toHaveBeenCalledWith(2)
    })
  })

  describe('visible foreground agent sampling (perf)', () => {
    const VISIBLE_PTY_SETTLE_MS = 350
    const WRAPPER_RESOLVE_RETRY_MS = 1200
    const SECOND_WRAPPER_RETRY_MS = 6000

    // Why: bindings share the tab-1/LEAF_1 pane key; give each sampling case its own tabId so no other test's publish pollutes it.
    async function connectRestoredPaneForForegroundSampling(
      args: {
        ptyId?: string
        tabId?: string
        isVisibleRef?: { current: boolean }
        launchConfig?: {
          agentCommand?: string
          agentArgs: string
          agentEnv: Record<string, string>
        }
        launchAgent?: TuiAgent
      } = {}
    ): Promise<{
      binding: {
        noteVisibilityResume: () => void
        sampleForegroundAgentOnFocus: () => void
        requestDroidReconfirmation: () => void
      }
      deps: ReturnType<typeof createDeps>
      transport: MockTransport
      cacheKey: string
    }> {
      const { connectPanePty } = await import('./pty-connection')
      const ptyId = args.ptyId ?? 'tab-pty'
      const tabId = args.tabId ?? `tab-${ptyId}`
      const hasReattachMetadata = args.launchConfig !== undefined || args.launchAgent !== undefined
      const transport = createMockTransport(hasReattachMetadata ? null : ptyId)
      let connectedPtyId: string | null = hasReattachMetadata ? null : ptyId
      transport.getPtyId.mockImplementation(() => connectedPtyId)
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        connectedPtyId = sessionId ?? null
        return sessionId
          ? {
              id: sessionId,
              ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
              ...(args.launchAgent ? { launchAgent: args.launchAgent } : {})
            }
          : null
      })
      transportFactoryQueue.push(transport)
      const deps = createDeps({
        tabId,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: ptyId },
        ...(args.isVisibleRef ? { isVisibleRef: args.isVisibleRef } : {})
      })
      const binding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        deps as never
      ) as unknown as {
        noteVisibilityResume: () => void
        sampleForegroundAgentOnFocus: () => void
        requestDroidReconfirmation: () => void
      }
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(20)
      return { binding, deps, transport, cacheKey: makePaneKey(tabId, LEAF_1) }
    }

    async function advanceVisibleForegroundRead(): Promise<void> {
      await vi.advanceTimersByTimeAsync(VISIBLE_PTY_SETTLE_MS)
      await flushAsyncTicks()
    }

    function foregroundReadCallsFor(ptyId: string): unknown[][] {
      return vi
        .mocked(window.api.pty.getForegroundProcess)
        .mock.calls.filter(([calledPtyId]) => calledPtyId === ptyId)
    }

    it('does not inspect foreground process for a fresh visible spawn', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-fresh-visible-no-sample'
      transportFactoryQueue.push(createMockTransport(ptyId))
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_1 },
            activeLeafId: LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        }
      } as StoreState

      connectPanePty(createPane(1) as never, createManager(1) as never, createDeps() as never)
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(20)
      const spawnHandler = createdTransportOptions[0]?.onPtySpawn as
        | ((ptyId: string) => void)
        | undefined
      spawnHandler?.(ptyId)
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('samples exactly one visible restored PTY with no stronger identity signal', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-restored-visible-sample'

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({ ptyId })
      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)

      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toEqual([[ptyId]])
      expect(mockStoreState.setPaneForegroundAgent).toHaveBeenCalledWith(cacheKey, {
        agent: 'codex',
        shellForeground: false
      })
    })

    it('does not sample hidden restored PTYs', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-hidden-restored-no-sample'

      await connectRestoredPaneForForegroundSampling({
        ptyId,
        isVisibleRef: { current: false }
      })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('does not confirm foreground routing for a Windows WSL pane', async () => {
      vi.useFakeTimers()
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      const ptyId = 'pty-wsl-no-confirm'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = {
        'wt-1': [{ id: tabId, ptyId, shellOverride: 'wsl.exe' }]
      }

      try {
        const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({
          ptyId,
          tabId
        })
        mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
          agent: 'droid',
          routingTrusted: true,
          shellForeground: false
        }

        binding.sampleForegroundAgentOnFocus()
        await vi.advanceTimersByTimeAsync(10_000)

        // Scope to this pane's pty id: a delayed confirm for another test's pane can fire during this advance.
        expect(window.api.pty.confirmForegroundProcess).not.toHaveBeenCalledWith(ptyId)
      } finally {
        restoreUserAgent()
      }
    })

    it('keeps trusted Droid routing through a rapid Shift+Enter burst', async () => {
      vi.useFakeTimers()
      const ptyId = 'pty-droid-shift-enter-burst'
      const tabId = `tab-${ptyId}`
      const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId
      })
      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      }
      mockStoreState.agentStatusByPaneKey[cacheKey] = {
        state: 'working',
        agentType: 'droid'
      }
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('droid')

      binding.requestDroidReconfirmation()
      await vi.advanceTimersByTimeAsync(200)
      binding.requestDroidReconfirmation()
      await vi.advanceTimersByTimeAsync(349)

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      })

      await vi.advanceTimersByTimeAsync(1)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        shellForeground: false
      })

      await vi.advanceTimersByTimeAsync(350)
      await flushAsyncTicks()
      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledWith(ptyId)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      })

      binding.requestDroidReconfirmation()
      await vi.advanceTimersByTimeAsync(700)
      await flushAsyncTicks()
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      })
    })

    it('samples once when an identityless hidden pane resumes visible', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const isVisibleRef = { current: false }
      const ptyId = 'pty-hidden-then-visible-sample'
      const { binding } = await connectRestoredPaneForForegroundSampling({ ptyId, isVisibleRef })
      await advanceVisibleForegroundRead()
      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toEqual([[ptyId]])
    })

    it('confirms daemon launch identity before restoring warm-reattach routing', async () => {
      vi.useFakeTimers()
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('droid')
      const ptyId = 'pty-launch-identity-no-sample'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = { 'wt-1': [{ id: tabId, ptyId }] }

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        launchAgent: 'droid'
      })
      expect(mockStoreState.registerAgentLaunchConfig).not.toHaveBeenCalled()
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')

      await advanceVisibleForegroundRead()

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('csi-u')
    })

    it('retires stale daemon launch identity when warm reattach finds the shell', async () => {
      vi.useFakeTimers()
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('powershell.exe')
      const ptyId = 'pty-stale-daemon-launch-identity'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = { 'wt-1': [{ id: tabId, ptyId }] }

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        launchAgent: 'droid'
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')

      await vi.advanceTimersByTimeAsync(
        VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
      )
      await flushAsyncTicks()

      // Assert the floor (initial read + two retries), not an exact count: an incidental droid reconfirm can add one more.
      expect(
        vi.mocked(window.api.pty.confirmForegroundProcess).mock.calls.length
      ).toBeGreaterThanOrEqual(3)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: null,
        shellForeground: true
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
    })

    it('fails closed when a warm reattach has no persisted launch identity', async () => {
      vi.useFakeTimers()
      const ptyId = 'pty-reattach-missing-launch-identity'
      const tabId = `tab-${ptyId}`

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        isVisibleRef: { current: false }
      })

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toBeUndefined()
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
    })

    it('does not let persisted args spoof pane identity without an allowlisted command', async () => {
      vi.useFakeTimers()
      const ptyId = 'pty-unknown-persisted-launch'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = { 'wt-1': [{ id: tabId, ptyId }] }
      mockStoreState.registerAgentLaunchConfig.mockImplementation(
        (key: string, launchConfig: unknown, identity: { agentType?: string }): void => {
          mockStoreState.agentLaunchConfigByPaneKey[key] = { launchConfig, identity }
        }
      )

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        isVisibleRef: { current: false },
        launchConfig: {
          agentCommand: 'custom-wrapper --agent droid',
          agentArgs: 'droid',
          agentEnv: {}
        }
      })
      await vi.advanceTimersByTimeAsync(300)
      await flushAsyncTicks(20)

      expect(
        mockStoreState.agentLaunchConfigByPaneKey[cacheKey]?.identity?.agentType
      ).toBeUndefined()
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
    })

    it('does not re-scan stale launch metadata after the local ladder confirms shell', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('powershell.exe')
      const isVisibleRef = { current: false }
      const ptyId = 'pty-stale-launch-shell-settled'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = {
        'wt-1': [{ id: tabId, ptyId, launchAgent: 'droid' }]
      }
      mockStoreState.registerAgentLaunchConfig.mockImplementation(
        (key: string, launchConfig: unknown, identity: { agentType?: string }): void => {
          mockStoreState.agentLaunchConfigByPaneKey[key] = { launchConfig, identity }
        }
      )
      mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
        delete mockStoreState.agentLaunchConfigByPaneKey[key]
      })

      const { binding, cacheKey } = await connectRestoredPaneForForegroundSampling({
        ptyId,
        tabId,
        isVisibleRef,
        launchConfig: { agentCommand: 'droid', agentArgs: '', agentEnv: {} }
      })
      await vi.advanceTimersByTimeAsync(300)
      await flushAsyncTicks(20)
      // Launch metadata starts confirmation but is never byte-routing authority.
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')
      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await advanceVisibleForegroundRead()
      await vi.advanceTimersByTimeAsync(WRAPPER_RESOLVE_RETRY_MS)
      await vi.advanceTimersByTimeAsync(SECOND_WRAPPER_RETRY_MS)

      expect(foregroundReadCallsFor(ptyId).length).toBeGreaterThanOrEqual(3)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: null,
        shellForeground: true
      })
      expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(cacheKey)

      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: null,
        shellForeground: false
      }
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey)).toBe('alt-enter')

      vi.clearAllTimers()
      const settledReadCount = foregroundReadCallsFor(ptyId).length
      binding.sampleForegroundAgentOnFocus()
      await vi.advanceTimersByTimeAsync(
        VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
      )
      expect(foregroundReadCallsFor(ptyId)).toHaveLength(settledReadCount)
    })

    it('does not sample when a live hook row already supplies pane identity', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-hook-identity-no-sample'
      const tabId = `tab-${ptyId}`
      mockStoreState.agentStatusByPaneKey[makePaneKey(tabId, LEAF_1)] = {
        state: 'working',
        agentType: 'codex'
      }

      await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('does not sample when process identity is already known', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-process-identity-no-sample'
      const tabId = `tab-${ptyId}`
      mockStoreState.paneForegroundAgentByPaneKey[makePaneKey(tabId, LEAF_1)] = {
        agent: 'codex',
        routingTrusted: true,
        shellForeground: false
      }

      await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('does not re-sample once 133;D proved the pane is at a shell prompt', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-shell-foreground-no-sample'
      const tabId = `tab-${ptyId}`
      mockStoreState.paneForegroundAgentByPaneKey[makePaneKey(tabId, LEAF_1)] = {
        agent: null,
        shellForeground: true
      }

      await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('does not re-sample a shell-confirmed pane from stale launch metadata', async () => {
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-shell-foreground-launch-agent-sample'
      const tabId = `tab-${ptyId}`
      mockStoreState.tabsByWorktree = {
        'wt-1': [{ id: tabId, ptyId, launchAgent: 'codex' }]
      }
      mockStoreState.paneForegroundAgentByPaneKey[makePaneKey(tabId, LEAF_1)] = {
        agent: null,
        shellForeground: true
      }

      const { cacheKey } = await connectRestoredPaneForForegroundSampling({ ptyId, tabId })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
      expect(mockStoreState.setPaneForegroundAgent).not.toHaveBeenCalledWith(
        cacheKey,
        expect.anything()
      )
    })

    it('fails closed when a leaked 133;D cancels identityless recovery', async () => {
      // Why: a cached visible read has no routing authority; on a racing command boundary, trust the shell marker over stale identity.
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'pty-reattach-idle-codex-leaked-d'
      const tabId = `tab-${ptyId}`
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks?.onData ?? null
          return sessionId ? { id: sessionId } : null
        }
      )
      transportFactoryQueue.push(transport)
      const deps = createDeps({
        tabId,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: ptyId }
      })
      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(20)

      const cacheKey = makePaneKey(tabId, LEAF_1)
      dataCallbackRef.current?.('\x1b]133;D;0\x07')

      await advanceVisibleForegroundRead()

      expect(mockStoreState.setPaneForegroundAgent).toHaveBeenCalledWith(cacheKey, {
        agent: null,
        shellForeground: true
      })
      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })

    it('re-confirms leaked 133;D after detach moved pane-scoped Droid identity', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('droid')
      const ptyId = 'pty-detached-droid-leaked-d'
      const tabId = 'tab-detached-droid'
      const cacheKey = makePaneKey(tabId, LEAF_1)
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks?.onData ?? null
          return sessionId ? { id: sessionId } : null
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState.paneForegroundAgentByPaneKey[cacheKey] = {
        agent: 'droid',
        shellForeground: false
      }
      mockStoreState.agentLaunchConfigByPaneKey[cacheKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: 'droid' }
      }
      const deps = createDeps({
        tabId,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: ptyId }
      })

      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(20)
      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toEqual([[ptyId]])
      expect(mockStoreState.setPaneForegroundAgent).not.toHaveBeenCalledWith(cacheKey, {
        agent: null,
        shellForeground: true
      })
      expect(mockStoreState.setPaneForegroundAgent).toHaveBeenCalledWith(cacheKey, {
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      })
    })

    it('never probes the foreground for a visible remote/SSH restored pane', async () => {
      // Why: foreground reads are local-only (expensive RPCs); keep remote/SSH panes off the recovery probe.
      vi.useFakeTimers()
      const getForegroundProcess = vi.mocked(window.api.pty.getForegroundProcess)
      getForegroundProcess.mockResolvedValue('codex')
      const ptyId = 'remote:web-env-1@@pty-remote-idle-agent'

      await connectRestoredPaneForForegroundSampling({ ptyId, tabId: 'tab-remote-idle-agent' })
      await advanceVisibleForegroundRead()

      expect(foregroundReadCallsFor(ptyId)).toHaveLength(0)
    })
  })

  describe('terminal input liveness IPC gating (perf)', () => {
    // Why (perf regression guard): listSessions() is a renderer→main→daemon round-trip; terminal input must never trigger it.
    async function connectActivePaneWithInput(): Promise<{
      binding: { noteVisibilityResume: () => void }
      transport: MockTransport
      typeKeystroke: (data?: string) => void
    }> {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const pane = createPane(2)
      const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
        noteVisibilityResume: () => void
      }
      return {
        binding,
        transport,
        // Drives the real xterm onData (terminal input) handler.
        typeKeystroke: (data = 'a') => sendTerminalInputThroughPane(pane, data)
      }
    }

    it('does not fire listSessions for first input on a fresh mount', async () => {
      const listSessions = vi.mocked(window.api.pty.listSessions)
      listSessions.mockClear()
      const { typeKeystroke } = await connectActivePaneWithInput()

      for (let i = 0; i < 25; i++) {
        typeKeystroke('x')
      }

      expect(listSessions).not.toHaveBeenCalled()
    })

    it('does not fire listSessions for input after a visibility resume', async () => {
      const listSessions = vi.mocked(window.api.pty.listSessions)
      listSessions.mockClear()
      const { binding, typeKeystroke } = await connectActivePaneWithInput()

      binding.noteVisibilityResume()
      typeKeystroke('a')
      typeKeystroke('b')

      expect(listSessions).not.toHaveBeenCalled()
    })

    it('sends the first post-resume input without starting the liveness re-check', async () => {
      const listSessions = vi.mocked(window.api.pty.listSessions)
      listSessions.mockClear()
      const calls: string[] = []
      listSessions.mockImplementation(() => {
        calls.push('listSessions')
        return Promise.resolve([])
      })
      const { binding, transport, typeKeystroke } = await connectActivePaneWithInput()
      transport.sendInput.mockImplementation(() => {
        calls.push('sendInput')
        return true
      })

      binding.noteVisibilityResume()
      typeKeystroke('a')

      expect(calls).toEqual(['sendInput'])
    })

    it('does not re-arm input-driven listSessions across repeated visibility resumes', async () => {
      const listSessions = vi.mocked(window.api.pty.listSessions)
      listSessions.mockClear()
      const { binding, typeKeystroke } = await connectActivePaneWithInput()

      binding.noteVisibilityResume()
      typeKeystroke('a')
      typeKeystroke('b')
      expect(listSessions).not.toHaveBeenCalled()

      binding.noteVisibilityResume()
      typeKeystroke('c')
      typeKeystroke('d')
      expect(listSessions).not.toHaveBeenCalled()
    })
  })

  describe('PTY size re-assert on visibility resume', () => {
    // Why: a resize dropped while hidden leaves xterm and the PTY diverged, and dedupe hides it; resume re-asserts on real drift.
    async function connectResumablePane(depsOverrides: Record<string, unknown> = {}): Promise<{
      binding: { noteVisibilityResume: () => void }
      transport: MockTransport
      deps: ReturnType<typeof createDeps>
      pane: ReturnType<typeof createPane>
    }> {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) },
        ...depsOverrides
      })
      const pane = createPane(2)
      const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
        noteVisibilityResume: () => void
      }
      return { binding, transport, deps, pane }
    }

    function installObservedPane(pane: ReturnType<typeof createPane>): {
      trigger: () => void
      restore: () => void
    } {
      const originalResizeObserver = globalThis.ResizeObserver
      const originalElement = globalThis.Element
      const hadResizeObserver = 'ResizeObserver' in globalThis
      const hadElement = 'Element' in globalThis
      type ResizeObserverCallbackLike = ConstructorParameters<typeof ResizeObserver>[0]
      class MockElement extends EventTarget {
        dataset: Record<string, string> = {}
        classList = { contains: (className: string) => className === 'pane' }

        querySelectorAll(): MockElement[] {
          return []
        }
      }
      class MockResizeObserver {
        static instances: MockResizeObserver[] = []
        observe = vi.fn()
        disconnect = vi.fn()

        constructor(private readonly callback: ResizeObserverCallbackLike) {
          MockResizeObserver.instances.push(this)
        }

        trigger(): void {
          this.callback([], this as never)
        }
      }

      globalThis.Element = MockElement as never
      globalThis.ResizeObserver = MockResizeObserver as never
      pane.container = new MockElement() as unknown as HTMLElement

      return {
        trigger: () => MockResizeObserver.instances[0]?.trigger(),
        restore: () => {
          if (hadResizeObserver) {
            globalThis.ResizeObserver = originalResizeObserver
          } else {
            Reflect.deleteProperty(globalThis, 'ResizeObserver')
          }
          if (hadElement) {
            globalThis.Element = originalElement
          } else {
            Reflect.deleteProperty(globalThis, 'Element')
          }
        }
      }
    }

    it('re-asserts the current size when the PTY drifted from xterm', async () => {
      vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 80, rows: 24 })
      const { binding, transport } = await connectResumablePane()
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      // xterm is 120x40 (createPane default), PTY reports 80x24 → re-assert.
      expect(transport.resize).toHaveBeenCalledWith(120, 40, { claim: true })
    })

    it('does not fit during visibility-resume reassertion', async () => {
      vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 80, rows: 24 })
      const { binding, transport, pane } = await connectResumablePane()
      const fit = vi.fn(() => {
        pane.terminal.cols = 132
        pane.terminal.rows = 40
      })
      pane.fitAddon = {
        ...pane.fitAddon,
        fit,
        proposeDimensions: vi.fn(() => ({ cols: 132, rows: 40 }))
      } as never
      Object.defineProperty(pane.container, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ width: 1130, height: 688 })
      })
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(fit).not.toHaveBeenCalled()
      expect(transport.resize).toHaveBeenCalledWith(120, 40, { claim: true })
    })

    it('re-asserts after observed pane geometry changes while visible', async () => {
      const pane = createPane(2)
      const observer = installObservedPane(pane)
      try {
        vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 200, rows: 40 })
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        pane.terminal.cols = 82
        pane.terminal.rows = 40

        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        transport.resize.mockClear()
        vi.mocked(window.api.pty.getSize).mockClear()

        observer.trigger()
        await flushAsyncTicks()

        expect(window.api.pty.getSize).toHaveBeenCalledWith('pty-pane-2')
        expect(transport.resize).toHaveBeenCalledWith(82, 40, { claim: true })
      } finally {
        observer.restore()
      }
    })

    it('repairs stale xterm grid drift on foreground output even without a pane resize', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const pane = createPane(2)
      let proposedGrid = { cols: 62, rows: 63 }
      pane.terminal.cols = 62
      pane.terminal.rows = 63
      pane.fitAddon = {
        ...pane.fitAddon,
        fit: vi.fn(() => {
          pane.terminal.cols = proposedGrid.cols
          pane.terminal.rows = proposedGrid.rows
        }),
        proposeDimensions: vi.fn(() => proposedGrid)
      } as never
      vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 62, rows: 63 })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      proposedGrid = { cols: 65, rows: 63 }
      vi.mocked(pane.fitAddon.fit).mockClear()
      transport.resize.mockClear()
      vi.mocked(window.api.pty.getSize).mockClear()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('\x1b[?2026hcodex redraw frame')
      await flushAsyncTicks()

      expect(pane.fitAddon.fit).toHaveBeenCalled()
      expect(window.api.pty.getSize).toHaveBeenCalledWith('pty-pane-2')
      expect(transport.resize).toHaveBeenCalledWith(65, 63, { claim: true })
    })

    it('skips foreground grid drift repair while mobile owns the PTY without a fit override', async () => {
      const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('pty-pane-2')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-pane-2'
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const pane = createPane(2)
      let proposedGrid = { cols: 62, rows: 63 }
      pane.terminal.cols = 62
      pane.terminal.rows = 63
      pane.fitAddon = {
        ...pane.fitAddon,
        fit: vi.fn(() => {
          pane.terminal.cols = proposedGrid.cols
          pane.terminal.rows = proposedGrid.rows
        }),
        proposeDimensions: vi.fn(() => proposedGrid)
      } as never

      try {
        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        proposedGrid = { cols: 65, rows: 63 }
        setDriverForPty('pty-pane-2', { kind: 'mobile', clientId: 'phone-1' })
        vi.mocked(pane.fitAddon.fit).mockClear()
        transport.resize.mockClear()
        vi.mocked(window.api.pty.getSize).mockClear()
        expect(capturedDataCallback.current).not.toBeNull()

        capturedDataCallback.current?.('\x1b[?2026hcodex redraw frame')
        await flushAsyncTicks()

        expect(pane.fitAddon.fit).not.toHaveBeenCalled()
        expect(window.api.pty.getSize).not.toHaveBeenCalled()
        expect(transport.resize).not.toHaveBeenCalled()
      } finally {
        setDriverForPty('pty-pane-2', { kind: 'idle' })
      }
    })

    it('reports desktop geometry without resizing while a mobile-fit override is active', async () => {
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      const pane = createPane(2)
      const observer = installObservedPane(pane)
      try {
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        pane.fitAddon = {
          ...pane.fitAddon,
          proposeDimensions: vi.fn(() => ({ cols: 101, rows: 33 }))
        } as never

        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        setFitOverride('pty-pane-2', 'mobile-fit', 40, 30)
        transport.resize.mockClear()
        vi.mocked(window.api.pty.getSize).mockClear()
        vi.mocked(window.api.pty.reportGeometry).mockClear()

        observer.trigger()
        await flushAsyncTicks()

        expect(window.api.pty.getSize).not.toHaveBeenCalled()
        expect(window.api.pty.reportGeometry).toHaveBeenCalledWith('pty-pane-2', 101, 33)
        expect(transport.resize).not.toHaveBeenCalled()
      } finally {
        setFitOverride('pty-pane-2', 'desktop-fit', 0, 0)
        observer.restore()
      }
    })

    it('updates the claiming desktop xterm before forwarding an observed viewport claim', async () => {
      const originalDocument = globalThis.document
      ;(globalThis as { document?: Document }).document = {
        visibilityState: 'visible',
        hasFocus: vi.fn(() => true)
      } as unknown as Document
      globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(0))
        return 1
      })
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      const pane = createPane(2)
      const observer = installObservedPane(pane)
      try {
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        let proposedGrid = { cols: 120, rows: 40 }
        pane.fitAddon = {
          ...pane.fitAddon,
          proposeDimensions: vi.fn(() => proposedGrid)
        } as never

        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        observer.trigger()
        await flushAsyncTicks()
        setFitOverride('pty-pane-2', 'remote-desktop-fit', 80, 24)
        proposedGrid = { cols: 70, rows: 30 }
        vi.mocked(pane.terminal.resize).mockClear()
        transport.resize.mockClear()

        observer.trigger()
        await flushAsyncTicks()

        expect(pane.terminal.resize).toHaveBeenCalledWith(70, 30)
        expect(transport.resize).toHaveBeenCalledTimes(1)
        expect(transport.resize).toHaveBeenCalledWith(70, 30, { claim: true })
      } finally {
        setFitOverride('pty-pane-2', 'desktop-fit', 0, 0)
        observer.restore()
        globalThis.document = originalDocument
      }
    })

    it('defers a remote-desktop viewport claim until structural replay completes', async () => {
      const originalDocument = globalThis.document
      ;(globalThis as { document?: Document }).document = {
        visibilityState: 'visible',
        hasFocus: vi.fn(() => true)
      } as unknown as Document
      globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
        queueMicrotask(() => callback(0))
        return 1
      })
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      const { beginTerminalScrollIntentBufferRebuild, endTerminalScrollIntentBufferRebuild } =
        await import('@/lib/pane-manager/terminal-scroll-intent-rebuild')
      const pane = createPane(2)
      const observer = installObservedPane(pane)
      try {
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        let proposedGrid = { cols: 120, rows: 40 }
        pane.fitAddon = {
          ...pane.fitAddon,
          proposeDimensions: vi.fn(() => proposedGrid)
        } as never
        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        observer.trigger()
        await flushAsyncTicks()
        setFitOverride('pty-pane-2', 'remote-desktop-fit', 80, 24)
        proposedGrid = { cols: 70, rows: 30 }
        vi.mocked(pane.terminal.resize).mockClear()
        transport.resize.mockClear()
        beginTerminalScrollIntentBufferRebuild(pane.terminal)

        observer.trigger()
        await flushAsyncTicks()
        expect(pane.terminal.resize).not.toHaveBeenCalled()
        expect(transport.resize).not.toHaveBeenCalled()

        endTerminalScrollIntentBufferRebuild(pane.terminal)
        await flushAsyncTicks()
        expect(pane.terminal.resize).toHaveBeenCalledWith(70, 30)
        expect(transport.resize).toHaveBeenCalledWith(70, 30, { claim: true })
      } finally {
        setFitOverride('pty-pane-2', 'desktop-fit', 0, 0)
        observer.restore()
        globalThis.document = originalDocument
      }
    })

    it('skips observed desktop reassertion while mobile owns the PTY without a fit override', async () => {
      const { setDriverForPty } = await import('@/lib/pane-manager/mobile-driver-state')
      const pane = createPane(2)
      const observer = installObservedPane(pane)
      try {
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        const fit = vi.fn()
        pane.fitAddon = {
          ...pane.fitAddon,
          fit,
          proposeDimensions: vi.fn(() => ({ cols: 130, rows: 50 }))
        } as never

        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks()
        setDriverForPty('pty-pane-2', { kind: 'mobile', clientId: 'phone-1' })
        transport.resize.mockClear()
        fit.mockClear()
        vi.mocked(window.api.pty.getSize).mockClear()
        vi.mocked(window.api.pty.reportGeometry).mockClear()

        observer.trigger()
        await flushAsyncTicks()

        expect(window.api.pty.getSize).not.toHaveBeenCalled()
        expect(window.api.pty.reportGeometry).not.toHaveBeenCalled()
        expect(transport.resize).not.toHaveBeenCalled()
        expect(fit).not.toHaveBeenCalled()
      } finally {
        setDriverForPty('pty-pane-2', { kind: 'idle' })
        observer.restore()
      }
    })

    it('does NOT re-assert when the PTY already matches xterm (no spurious SIGWINCH)', async () => {
      vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 120, rows: 40 })
      const { binding, transport } = await connectResumablePane()
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(transport.resize).not.toHaveBeenCalled()
    })

    it('re-asserts when the PTY size is unknown (cannot confirm synced)', async () => {
      vi.mocked(window.api.pty.getSize).mockResolvedValue(null)
      const { binding, transport } = await connectResumablePane()
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(transport.resize).toHaveBeenCalledWith(120, 40, { claim: true })
    })

    it('queues re-asserted resizes while pane resize holds are active', async () => {
      const originalCustomEvent = globalThis.CustomEvent
      class MockCustomEvent<T> extends Event {
        detail: T

        constructor(type: string, init: { detail: T }) {
          super(type)
          this.detail = init.detail
        }
      }
      globalThis.CustomEvent = MockCustomEvent as unknown as typeof CustomEvent
      try {
        const { holdPtyResizesForPaneSubtrees, queuePanePtyResizeIfHeld } =
          await import('@/lib/pane-manager/pane-pty-resize-hold')
        vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 80, rows: 24 })
        const { binding, transport, pane } = await connectResumablePane()
        await flushAsyncTicks()
        Object.defineProperty(pane.container, 'classList', {
          configurable: true,
          value: { contains: (className: string) => className === 'pane' }
        })
        Object.defineProperty(pane.container, 'querySelectorAll', {
          configurable: true,
          value: () => []
        })
        const release = holdPtyResizesForPaneSubtrees([pane.container])
        // Prove the fixture uses the same held pane before reassertion overwrites the queued placeholder size.
        expect(queuePanePtyResizeIfHeld(pane.container, 1, 1)).toBe(true)
        transport.resize.mockClear()

        binding.noteVisibilityResume()
        await flushAsyncTicks()

        expect(transport.resize).not.toHaveBeenCalled()

        release.flush()

        expect(transport.resize).toHaveBeenCalledTimes(1)
        expect(transport.resize).toHaveBeenCalledWith(120, 40, { claim: true })
      } finally {
        globalThis.CustomEvent = originalCustomEvent
      }
    })

    it('skips remote-runtime PTYs (their size lives outside the local ptySizes map)', async () => {
      const getSize = vi.mocked(window.api.pty.getSize)
      getSize.mockClear()
      const { connectPanePty } = await import('./pty-connection')
      const transport = createMockTransport('remote:env-1@@terminal-2')
      transport.getConnectionId.mockReturnValue(null)
      transportFactoryQueue.push(transport)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
      })
      const pane = createPane(2)
      const binding = connectPanePty(pane as never, manager as never, deps as never) as unknown as {
        noteVisibilityResume: () => void
      }
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      // Never even queries size for a remote pane, and never re-asserts.
      expect(getSize).not.toHaveBeenCalled()
      expect(transport.resize).not.toHaveBeenCalled()
    })

    it('does NOT re-assert while a mobile-fit override parks the PTY at phone dims', async () => {
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      vi.mocked(window.api.pty.getSize).mockResolvedValue({ cols: 80, rows: 24 })
      const { binding, transport } = await connectResumablePane()
      // Park the PTY at phone dims — desktop re-assert must be suppressed.
      setFitOverride('pty-pane-2', 'mobile-fit', 40, 30)
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      await flushAsyncTicks()

      expect(transport.resize).not.toHaveBeenCalled()
      setFitOverride('pty-pane-2', 'desktop-fit', 0, 0)
    })

    it('does NOT forward when the pane is hidden again before getSize resolves (stale hop)', async () => {
      // Stale getSize resolving after re-hide must not emit a hidden-tab SIGWINCH (which resets alt-screen TUIs).
      let resolveSize: (v: { cols: number; rows: number } | null) => void = () => {}
      vi.mocked(window.api.pty.getSize).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSize = resolve
          })
      )
      const { binding, transport, deps } = await connectResumablePane()
      transport.resize.mockClear()

      binding.noteVisibilityResume()
      // Pane is hidden again while the size query is still in flight.
      deps.isVisibleRef.current = false
      resolveSize({ cols: 80, rows: 24 }) // drift — would re-assert if visible
      await flushAsyncTicks()

      expect(transport.resize).not.toHaveBeenCalled()
    })

    it('coalesces overlapping resumes into a single size query (re-entrancy guard)', async () => {
      const getSize = vi.mocked(window.api.pty.getSize)
      getSize.mockClear()
      let resolveSize: (v: { cols: number; rows: number } | null) => void = () => {}
      getSize.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSize = resolve
          })
      )
      const { binding } = await connectResumablePane()
      getSize.mockClear()

      // Two rapid resumes before the first query resolves → only one query.
      binding.noteVisibilityResume()
      binding.noteVisibilityResume()
      expect(getSize).toHaveBeenCalledTimes(1)
      resolveSize({ cols: 120, rows: 40 })
      await flushAsyncTicks()
    })
  })
})
