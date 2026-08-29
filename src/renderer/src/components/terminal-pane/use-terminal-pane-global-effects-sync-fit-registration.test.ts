import type * as ReactModule from 'react'
import type * as StoreModule from '@/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'
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

  it('skips global sync-fit registration for hidden non-measurable terminal panes', () => {
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null)
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: false,
      isVisible: false,
      isSyncFitEnabled: false,
      paneCount: 0,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const syncFitListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === SYNC_FIT_PANES_EVENT)

    expect(syncFitListener).toBeUndefined()
  })

  it('registers global sync-fit for measurable hidden startup panes', () => {
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      resetWebglTextureAtlases: vi.fn(),
      scheduleRevealRepaint: vi.fn(),
      scheduleRevealPresent: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      fitAllRevealedPanes: vi.fn(),
      getActivePane: vi.fn(() => null)
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: false,
      isVisible: false,
      isSyncFitEnabled: true,
      paneCount: 0,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const syncFitListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === SYNC_FIT_PANES_EVENT)

    expect(syncFitListener).toBeDefined()
    const listener = syncFitListener?.[1]
    if (typeof listener !== 'function') {
      throw new Error('expected sync-fit listener')
    }
    listener(new Event(SYNC_FIT_PANES_EVENT))
    expect(manager.fitAllPanes).toHaveBeenCalledTimes(1)
  })
})
