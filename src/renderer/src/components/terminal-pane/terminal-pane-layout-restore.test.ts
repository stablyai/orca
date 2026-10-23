// A restored pane's history: the window's saved copy only with the switch off. Layout-owner
// builds paint history only from the terminal's host (L236).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const restoreScrollbackBuffers = vi.fn()
const setTabLayout = vi.fn()
const setTabLocalOnlyScrollback = vi.fn()
const TAB = 'tab-1'
const LEAF = 'leaf-1'

vi.mock('./layout-serialization', () => ({
  replayTerminalLayout: () => new Map([[LEAF, 1]]),
  restoreScrollbackBuffers: (...args: unknown[]) => restoreScrollbackBuffers(...args)
}))
vi.mock('./expand-collapse', () => ({ applyExpandedLayoutTo: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      localOnlyScrollbackByTabId: { [TAB]: { [LEAF]: 'local-only history' } },
      repos: [{ id: 'repo', connectionId: 'ssh-1' }],
      setTabLayout,
      setTabLocalOnlyScrollback
    })
  }
}))

async function restoreWithSwitch(on: boolean): Promise<void> {
  vi.resetModules()
  vi.doMock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: on }))
  const { restoreTerminalPaneLayout } = await import('./terminal-pane-layout-restore')
  const manager = {
    getActivePane: () => ({ id: 1 }),
    getPanes: () => [{ id: 1 }],
    setActivePane: vi.fn()
  }
  const initialLayoutRef = {
    current: {
      root: { type: 'leaf' as const, leafId: LEAF },
      activeLeafId: LEAF,
      expandedLeafId: null,
      buffersByLeafId: { [LEAF]: 'shared history' }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restore reads only the members this fixture supplies.
  const args = {
    manager,
    deps: {
      initialLayoutRef,
      tabId: TAB,
      worktreeId: 'repo::/wt',
      isActive: false,
      managerRef: { current: manager },
      replayingPanesRef: { current: new Map() },
      setPaneTitles: vi.fn(),
      paneTitlesRef: { current: {} },
      setExpandedPane: vi.fn()
    },
    refs: { restoredViewportBlankingPanesRef: { current: new Set() } },
    ptyDeps: { mountFollowsTerminalPark: false },
    initialLayoutHadBuffers: true
  } as unknown as Parameters<typeof restoreTerminalPaneLayout>[0]
  restoreTerminalPaneLayout(args)
}

describe('restoreTerminalPaneLayout history source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('paints the window copy with the switch off', async () => {
    await restoreWithSwitch(false)
    expect(restoreScrollbackBuffers.mock.calls[0]?.[1]).toEqual({ [LEAF]: 'local-only history' })
  })

  it('paints no window copy in the layout-owner build, and keeps the copy untouched', async () => {
    await restoreWithSwitch(true)
    expect(restoreScrollbackBuffers.mock.calls[0]?.[1]).toBeUndefined()
    expect(setTabLayout).not.toHaveBeenCalled()
    expect(setTabLocalOnlyScrollback).not.toHaveBeenCalled()
  })
})
