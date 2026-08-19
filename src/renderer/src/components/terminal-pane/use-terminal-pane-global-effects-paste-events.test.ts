import type * as ReactModule from 'react'
import type * as StoreModule from '@/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PASTE_TERMINAL_TEXT_EVENT } from '@/constants/terminal'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
import { TERMINAL_PASTE_DIRECT_MAX_BYTES } from './terminal-paste-coordinator'
import {
  cleanupGlobalEffectsTestWindow,
  installGlobalEffectsTestWindow
} from './use-terminal-pane-global-effects-test-harness'

const mocks = vi.hoisted(() => ({
  captureScrollState: vi.fn(),
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  focusActivePane: vi.fn(),
  flushTerminalOutput: vi.fn(),
  getTerminalOutputEpoch: vi.fn(() => 0),
  handleTerminalFileDrop: vi.fn(),
  enforceTerminalCurrentScrollIntent: vi.fn(),
  syncTerminalScrollIntentFromViewport: vi.fn(),
  pasteTerminalText: vi.fn(),
  recordTerminalUserInputForLeaf: vi.fn(),
  requestTerminalBacklogRecovery: vi.fn(),
  restoreScrollState: vi.fn(),
  restoreScrollStateAfterLayout: vi.fn()
}))

const reactRefState = vi.hoisted(() => ({
  slots: [] as { current: unknown }[],
  index: 0
}))

function beginHookRender(): void {
  reactRefState.index = 0
}

function resetHookRefs(): void {
  reactRefState.slots = []
  reactRefState.index = 0
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
    useRef: <T>(value: T) => {
      const index = reactRefState.index
      reactRefState.index += 1
      if (!reactRefState.slots[index]) {
        reactRefState.slots[index] = { current: value }
      }
      return reactRefState.slots[index] as { current: T }
    }
  }
})

vi.mock('./pane-helpers', () => ({
  fitAndFocusPanes: mocks.fitAndFocusPanes,
  fitPanes: mocks.fitPanes,
  focusActivePane: mocks.focusActivePane
}))

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: mocks.flushTerminalOutput,
  requestTerminalBacklogRecovery: mocks.requestTerminalBacklogRecovery
}))

vi.mock('@/lib/pane-manager/pane-scroll', () => ({
  captureScrollState: mocks.captureScrollState,
  getTerminalOutputEpoch: mocks.getTerminalOutputEpoch,
  restoreScrollState: mocks.restoreScrollState,
  restoreScrollStateAfterLayout: mocks.restoreScrollStateAfterLayout
}))

vi.mock('@/lib/pane-manager/terminal-scroll-intent', () => ({
  enforceTerminalCurrentScrollIntent: mocks.enforceTerminalCurrentScrollIntent,
  syncTerminalScrollIntentFromViewport: mocks.syncTerminalScrollIntentFromViewport
}))

vi.mock('./terminal-drop-handler', () => ({
  handleTerminalFileDrop: mocks.handleTerminalFileDrop
}))

vi.mock('./terminal-bracketed-paste', () => ({
  BRACKETED_PASTE_END: '\u001b[201~',
  BRACKETED_PASTE_START: '\u001b[200~',
  pasteTerminalText: mocks.pasteTerminalText,
  sanitizeTerminalPasteText: (text: string) => text.split('\u001b').join('\u241b')
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

// Why: this suite invokes the hook outside a real React render (the react mock
// above runs effects synchronously and manages refs by hand), so a reactive
// useAppStore(selector) call would throw an "Invalid hook call". Read the
// current snapshot synchronously instead; getState/setState stay real so tests
// can seed terminalLayoutsByTabId.
vi.mock('@/store', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreModule>()
  const realHook = actual.useAppStore
  const testHook = ((selector?: (state: ReturnType<typeof realHook.getState>) => unknown) =>
    selector ? selector(realHook.getState()) : realHook.getState()) as typeof realHook
  Object.assign(testHook, realHook)
  return { ...actual, useAppStore: testHook }
})

async function flushPasteTasks(iterations = 3): Promise<void> {
  for (let index = 0; index < iterations; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('useTerminalPaneGlobalEffects', () => {
  beforeEach(() => {
    resetHookRefs()
    vi.clearAllMocks()
    installGlobalEffectsTestWindow()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    cleanupGlobalEffectsTestWindow()
  })

  it('records terminal input for targeted paste events', async () => {
    const terminal = { name: 'terminal-a', focus: vi.fn(), modes: { bracketedPasteMode: false } }
    const pane = { id: 1, leafId: 'leaf-1', terminal }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => pane)
    }
    const transport = {
      getPtyId: vi.fn(() => 'pty-1'),
      isConnected: vi.fn(() => true),
      sendInput: vi.fn<(data: string) => boolean>(() => true)
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      isSyncFitEnabled: true,
      paneCount: 1,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map([[pane.id, transport]]) as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const pasteListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === PASTE_TERMINAL_TEXT_EVENT)

    expect(pasteListener).toBeDefined()
    const listener = pasteListener?.[1]
    if (typeof listener !== 'function') {
      throw new Error('expected paste listener')
    }
    listener(
      new CustomEvent(PASTE_TERMINAL_TEXT_EVENT, { detail: { tabId: 'tab-1', text: 'git status' } })
    )

    await flushPasteTasks()

    expect(mocks.pasteTerminalText).toHaveBeenCalledWith(terminal, 'git status', {
      forceBracketedPaste: false
    })
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(terminal.focus).toHaveBeenCalledOnce()
  })

  it('chunks large programmatic paste events through the pane PTY transport', async () => {
    const largePaste = `${'x'.repeat(TERMINAL_PASTE_DIRECT_MAX_BYTES)}tail`
    const terminal = { name: 'terminal-a', focus: vi.fn(), modes: { bracketedPasteMode: false } }
    const pane = { id: 1, leafId: 'leaf-1', terminal }
    const manager = {
      getPanes: vi.fn(() => [pane]),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => pane)
    }
    const transport = {
      getPtyId: vi.fn(() => 'pty-1'),
      isConnected: vi.fn(() => true),
      sendInput: vi.fn<(data: string) => boolean>(() => true)
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      isSyncFitEnabled: true,
      paneCount: 1,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map([[1, transport]]) as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const pasteListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === PASTE_TERMINAL_TEXT_EVENT)

    expect(pasteListener).toBeDefined()
    const listener = pasteListener?.[1]
    if (typeof listener !== 'function') {
      throw new Error('expected paste listener')
    }
    listener(
      new CustomEvent(PASTE_TERMINAL_TEXT_EVENT, { detail: { tabId: 'tab-1', text: largePaste } })
    )

    await flushPasteTasks(12)

    expect(mocks.pasteTerminalText).not.toHaveBeenCalled()
    expect(transport.sendInput.mock.calls.map((call) => call[0]).join('')).toBe(largePaste)
    expect(transport.sendInput.mock.calls.length).toBeGreaterThan(1)
    expect(mocks.recordTerminalUserInputForLeaf).toHaveBeenCalledWith('tab-1', 'leaf-1')
    expect(terminal.focus).toHaveBeenCalledOnce()
  })
})
