import { vi } from 'vitest'
import type { Mock } from 'vitest'

export const LEAF_1 = '11111111-1111-4111-8111-111111111111' as const
export const LEAF_2 = '22222222-2222-4222-8222-222222222222' as const

export function leafIdForPane(paneId: number): string {
  return paneId === 2 ? LEAF_2 : LEAF_1
}

export type ConnectCallbacks = {
  onReattachDetermined?: () => void
  onConnect?: () => void
  onStreamRecovered?: () => void
  onData?: (
    data: string,
    meta?: { seq?: number; rawLength?: number; background?: boolean; droppedOutput?: boolean }
  ) => void
  onReplayData?: (data: string, meta?: { clearBeforeReplay?: boolean }) => void
  onError?: (msg: string) => void
  onErrorCleared?: (msg: string) => void
  onWriteUnavailable?: () => void
  onOutputPauseChanged?: (paused: boolean, supported: boolean) => void
}

export type MockTransport = {
  attach: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn> & {
    mockImplementation: (
      impl: (opts: { callbacks?: ConnectCallbacks } & Record<string, unknown>) => Promise<unknown>
    ) => unknown
  }
  disconnect: ReturnType<typeof vi.fn>
  detach?: ReturnType<typeof vi.fn>
  sendInput: ReturnType<typeof vi.fn>
  sendInputImmediate: ReturnType<typeof vi.fn>
  sendInputAccepted?: ReturnType<typeof vi.fn>
  claimViewport: ReturnType<typeof vi.fn>
  setOutputPaused?: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  getPtyId: ReturnType<typeof vi.fn>
  getConnectionId: ReturnType<typeof vi.fn>
  serializeBuffer?: ReturnType<typeof vi.fn>
  serializeBufferOutcome?: ReturnType<typeof vi.fn>
}

export function createMockTransport(initialPtyId: string | null = null): MockTransport {
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
    disconnect: vi.fn(() => {
      ptyId = null
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

export function createPaneContainer(): HTMLElement {
  const container = new EventTarget() as HTMLElement
  Object.defineProperty(container, 'dataset', {
    configurable: true,
    value: {}
  })
  return container
}

export type MockPaneDisposable = { dispose: Mock }

export type MockPaneBuffer = {
  type: 'normal' | 'alternate'
  viewportY: number
  baseY: number
  cursorY: number
  cursorX: number
}

export type MockPaneTerminal = {
  cols: number
  rows: number
  element: object
  buffer: { active: MockPaneBuffer }
  modes: { bracketedPasteMode: boolean; sendFocusMode: boolean }
  options: {
    scrollback: number
    ignoreBracketedPasteMode: boolean
    theme: { foreground: string; background: string }
  }
  write: Mock<(data: string, callback?: () => void) => void>
  resize: Mock<(cols: number, rows: number) => void>
  clear: Mock
  scrollToBottom: Mock<() => void>
  scrollToLine: Mock<(line: number) => void>
  scrollLines: Mock<(amount: number) => void>
  paste: Mock<(data: string) => void>
  onData: Mock
  onResize: Mock
  onRender: Mock
  onTitleChange: Mock
  hasSelection: Mock<() => boolean>
  parser: {
    registerCsiHandler: Mock
    registerOscHandler: Mock
  }
}

export type MockPane = {
  id: number
  leafId: string
  stablePaneId: string
  terminal: MockPaneTerminal
  container: HTMLElement
  fitAddon: {
    fit: Mock<() => void>
    proposeDimensions: Mock<() => { cols: number; rows: number }>
  }
}

export function createPane(paneId: number): MockPane {
  const leafId = leafIdForPane(paneId)
  const activeBuffer = {
    // Mutable so a test can put the pane on the alt screen: the replay prologue
    // only switches buffers when this disagrees with the snapshot.
    type: 'normal' as 'normal' | 'alternate',
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

export function captureCallbackTerminalWrites(pane: MockPane): {
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

export type MockPaneSummary = { id: number; leafId: string }

export type MockPaneManager = {
  setPaneGpuRendering: Mock
  markPaneHasComplexScriptOutput: Mock
  rebuildPaneWebgl: Mock
  hasWebglRenderer: Mock<() => boolean>
  getPanes: Mock<() => MockPaneSummary[]>
  closePane: Mock
  getActivePane: Mock<() => { id: number; leafId?: string } | null>
  getNumericIdForLeaf: Mock<(leafId: string) => number | null>
  setActivePane: Mock<(paneId: number) => void>
}

export function createManager(
  paneCount = 1,
  initialActivePaneId: number | null = null
): MockPaneManager {
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
