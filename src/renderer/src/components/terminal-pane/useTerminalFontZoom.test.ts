// @vitest-environment happy-dom
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mintStablePaneId } from '@/lib/pane-manager/mint-stable-pane-id'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import { useTerminalFontZoom } from './useTerminalFontZoom'
import { createTerminalPaneCreatedHandler } from './terminal-pane-pane-created'
import type { PaneCreatedSetupContext } from './terminal-pane-pane-created'
import { applyTerminalAppearance } from './terminal-appearance'
import {
  hydrateTerminalFontSizeOverride,
  resetTerminalFontSizeOverridesForTest
} from './terminal-font-size-overrides'

const TEST_LEAF_ID = mintStablePaneId()
const OTHER_TEST_LEAF_ID = mintStablePaneId()

const mocks = vi.hoisted(() => ({
  captureScrollState: vi.fn(() => ({ wasAtBottom: true })),
  restoreScrollState: vi.fn(),
  safeFit: vi.fn(),
  dispatchZoomLevelChanged: vi.fn()
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => effect()
  }
})

vi.mock('@/lib/pane-manager/pane-tree-ops', () => ({
  captureScrollState: mocks.captureScrollState,
  restoreScrollState: mocks.restoreScrollState,
  safeFit: mocks.safeFit
}))

vi.mock('@/lib/zoom-events', () => ({
  dispatchZoomLevelChanged: mocks.dispatchZoomLevelChanged
}))

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('./pty-connection', () => ({ connectPanePty: vi.fn(() => ({ dispose: vi.fn() })) }))
vi.mock('./terminal-pane-pane-input', () => ({ installTerminalPaneInputHandling: vi.fn() }))
vi.mock('./terminal-pane-pane-links', () => ({ installTerminalPaneLinkHandling: vi.fn() }))
// Treat the fixture as measurable so the real appearance pass writes font metrics immediately.
vi.mock('@/lib/pane-manager/pane-fit', () => ({ canApplyPaneMetricOptions: () => true }))

describe('useTerminalFontZoom', () => {
  let terminalZoomListeners: ((direction: 'in' | 'out' | 'reset') => void)[]

  beforeEach(() => {
    terminalZoomListeners = []
    document.body.replaceChildren()
    vi.clearAllMocks()
    resetTerminalFontSizeOverridesForTest()
    vi.stubGlobal('window', {
      api: {
        ui: {
          onTerminalZoom: vi.fn((listener: (direction: 'in' | 'out' | 'reset') => void) => {
            terminalZoomListeners.push(listener)
            return () => {}
          })
        }
      }
    })
  })

  function useMountedTerminalFontZoom(activeElement: HTMLElement): {
    terminal: { options: { fontSize?: number } }
    listener: (direction: 'in' | 'out' | 'reset') => void
  } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    container.appendChild(activeElement)
    activeElement.focus()
    const terminal = { options: { fontSize: 14 } }
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: container },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the manager members used by font zoom.
      managerRef: {
        current: {
          getActivePane: () => ({ id: 1, leafId: TEST_LEAF_ID, terminal })
        }
      } as never,
      paneFontSizesRef: { current: new Map() },
      settingsRef: { current: { terminalFontSize: 14 } }
    })
    const listener = terminalZoomListeners.at(-1)
    expect(listener).toBeTypeOf('function')
    return { terminal, listener: listener as (direction: 'in' | 'out' | 'reset') => void }
  }

  it('ignores zoom events when terminal input no longer owns focus', () => {
    const button = document.createElement('button')
    const { listener, terminal } = useMountedTerminalFontZoom(button)

    listener('in')

    expect(terminal.options.fontSize).toBe(14)
    expect(mocks.safeFit).not.toHaveBeenCalled()
    expect(mocks.dispatchZoomLevelChanged).not.toHaveBeenCalled()
  })

  it('applies terminal font zoom while the xterm helper textarea owns focus', () => {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    const { listener, terminal } = useMountedTerminalFontZoom(helper)

    listener('in')

    expect(terminal.options.fontSize).toBe(15)
    expect(mocks.safeFit).toHaveBeenCalledTimes(1)
    expect(mocks.dispatchZoomLevelChanged).toHaveBeenCalledWith('terminal', 107)
  })

  function createRemountedPane(id: number, leafId = TEST_LEAF_ID): ManagedPane {
    const terminal = {
      options: { fontSize: 14 },
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pane creation and appearance only use these pane members; input, links and PTY connection are mocked.
    const pane = { id, leafId, terminal } as unknown as ManagedPane
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every manager member called by the real appearance pass.
    const manager = {
      getPanes: () => [pane],
      setPaneLigaturesEnabled: vi.fn(),
      setPaneInlineImagesEnabled: vi.fn(),
      setPaneStyleOptions: vi.fn()
    } as unknown as PaneManager
    const paneFontSizes = new Map<number, number>()
    const settings = { ...getDefaultSettings('/tmp'), terminalFontSize: 14 }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies the real creation callback's members; mocked input/link/PTY boundaries do not consume their context.
    const context = {
      deps: {
        tabId: 'zoom-remount',
        managerRef: { current: manager },
        settingsRef: { current: settings },
        paneFontSizesRef: { current: paneFontSizes },
        paneCwdRef: { current: new Map() },
        panePtyBindingsRef: { current: new Map() }
      },
      refs: {
        osc52DisposablesRef: { current: new Map() },
        osc7DisposablesRef: { current: new Map() },
        queuedInitialCwdRef: { current: null }
      },
      ptyDeps: { cwd: '/tmp', startup: null },
      deferredSplitHandoffs: new Map(),
      defaultTabCwd: '/tmp',
      applyAppearance: (createdManager: PaneManager) =>
        applyTerminalAppearance(
          createdManager,
          settings,
          false,
          paneFontSizes,
          new Map(),
          'false',
          new Map(),
          new Map()
        ),
      syncPaneCount: vi.fn(),
      queueResizeAll: vi.fn()
    } as unknown as PaneCreatedSetupContext

    const onPaneCreated = createTerminalPaneCreatedHandler(context)
    onPaneCreated(pane, { cwd: '/tmp' })
    return pane
  }

  it('restores zoom before pane creation applies terminal appearance under a new runtime id', () => {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    const { listener, terminal } = useMountedTerminalFontZoom(helper)

    listener('in')
    expect(terminal.options.fontSize).toBe(15)

    expect(createRemountedPane(9).terminal.options.fontSize).toBe(15)
    expect(createRemountedPane(10, OTHER_TEST_LEAF_ID).terminal.options.fontSize).toBe(14)

    listener('reset')
    expect(createRemountedPane(11).terminal.options.fontSize).toBe(14)
  })

  it('retains a pane font override when the pane remounts with a new runtime id', () => {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    const { listener } = useMountedTerminalFontZoom(helper)

    listener('in')

    const remountedFontSizes = new Map<number, number>()
    hydrateTerminalFontSizeOverride({ id: 9, leafId: TEST_LEAF_ID }, remountedFontSizes)
    expect(remountedFontSizes.get(9)).toBe(15)

    listener('reset')
    hydrateTerminalFontSizeOverride({ id: 9, leafId: TEST_LEAF_ID }, remountedFontSizes)
    expect(remountedFontSizes.has(9)).toBe(false)
  })

  it('only lets the pane owning the focused helper apply terminal font zoom', () => {
    const inactiveContainer = document.createElement('div')
    const activeContainer = document.createElement('div')
    const focusedHelper = document.createElement('textarea')
    focusedHelper.className = 'xterm-helper-textarea'
    document.body.append(inactiveContainer, activeContainer)
    activeContainer.appendChild(focusedHelper)
    focusedHelper.focus()

    const inactiveTerminal = { options: { fontSize: 14 } }
    const activeTerminal = { options: { fontSize: 14 } }
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: inactiveContainer },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the manager members used by font zoom.
      managerRef: {
        current: {
          getActivePane: () => ({
            id: 1,
            leafId: TEST_LEAF_ID,
            terminal: inactiveTerminal
          })
        }
      } as never,
      paneFontSizesRef: { current: new Map() },
      settingsRef: { current: { terminalFontSize: 14 } }
    })
    useTerminalFontZoom({
      isActive: true,
      containerRef: { current: activeContainer },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the manager members used by font zoom.
      managerRef: {
        current: {
          getActivePane: () => ({
            id: 2,
            leafId: OTHER_TEST_LEAF_ID,
            terminal: activeTerminal
          })
        }
      } as never,
      paneFontSizesRef: { current: new Map() },
      settingsRef: { current: { terminalFontSize: 14 } }
    })

    for (const listener of terminalZoomListeners) {
      listener('in')
    }

    expect(inactiveTerminal.options.fontSize).toBe(14)
    expect(activeTerminal.options.fontSize).toBe(15)
    expect(mocks.safeFit).toHaveBeenCalledTimes(1)
  })
})
