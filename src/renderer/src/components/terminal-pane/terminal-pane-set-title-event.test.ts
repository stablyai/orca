import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_TERMINAL_PANE_EVENT, SET_TERMINAL_PANE_TITLE_EVENT } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

type Listener = (event: Event) => void
type TitleUpdate =
  | Record<number, string>
  | ((previous: Record<number, string>) => Record<number, string>)

function createHarness() {
  const listeners = new Map<string, Listener>()
  // Why: the listener writes the ref synchronously and the state setter for React; a real state cell proves both agree.
  const paneTitles: { current: Record<number, string> } = { current: {} }
  const removedLeafIds: { current: Set<string> } = { current: new Set<string>() }
  const titleWrites: Record<number, string>[] = []
  const setPaneTitles = (update: TitleUpdate): void => {
    paneTitles.current = typeof update === 'function' ? update(paneTitles.current) : { ...update }
    titleWrites.push({ ...paneTitles.current })
  }
  const removePaneTitle = vi.fn((paneId: number) => {
    const next = { ...paneTitles.current }
    delete next[paneId]
    paneTitles.current = next
    removedLeafIds.current.add(LEAF_ID)
  })
  const persistLayoutSnapshot = vi.fn()
  const managerRef: { current: PaneManager | null } = { current: null }
  // Why: the listener only ever asks the manager to resolve a leaf, so the stub stands in for the resolver surface it uses.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane listener reads only getNumericIdForLeaf/getPanes from the manager; a full PaneManager needs a DOM container this unit test does not mount.
  const manager = {
    getNumericIdForLeaf: (leafId: string) => (leafId === LEAF_ID ? 7 : null),
    getPanes: () => [{ id: 7, leafId: LEAF_ID }]
  } as unknown as PaneManager
  managerRef.current = manager

  vi.stubGlobal('window', {
    addEventListener: (type: string, handler: Listener) => listeners.set(type, handler),
    removeEventListener: (type: string) => listeners.delete(type)
  })

  const uninstall = installTerminalPaneMountEvents({
    manager,
    deps: {
      tabId: TAB_ID,
      worktreeId: 'wt-1',
      isActive: true,
      managerRef,
      persistLayoutSnapshot,
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn(),
      setPaneTitles,
      paneTitlesRef: paneTitles,
      removePaneTitle,
      removedTitleLeafIdsRef: removedLeafIds
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mount events under test never read pty deps; only the pane-title and close listeners are exercised here.
    ptyDeps: {} as PtyConnectionDeps
  })

  return {
    uninstall,
    dispatch: (detail: unknown) =>
      listeners.get(SET_TERMINAL_PANE_TITLE_EVENT)?.(
        new CustomEvent(SET_TERMINAL_PANE_TITLE_EVENT, { detail })
      ),
    hasCloseListener: () => listeners.has(CLOSE_TERMINAL_PANE_EVENT),
    hasTitleListener: () => listeners.has(SET_TERMINAL_PANE_TITLE_EVENT),
    paneTitles,
    removedLeafIds,
    titleWrites,
    removePaneTitle,
    persistLayoutSnapshot
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pane title event', () => {
  it('applies a title to the resolved pane and persists it', () => {
    const harness = createHarness()

    harness.dispatch({ tabId: TAB_ID, leafId: LEAF_ID, title: 'REVIEWER' })

    expect(harness.paneTitles.current).toEqual({ 7: 'REVIEWER' })
    expect(harness.persistLayoutSnapshot).toHaveBeenCalledTimes(1)
    expect(harness.removePaneTitle).not.toHaveBeenCalled()
  })

  it('clears only the resolved pane through removePaneTitle', () => {
    const harness = createHarness()
    harness.dispatch({ tabId: TAB_ID, leafId: LEAF_ID, title: 'REVIEWER' })
    harness.titleWrites.length = 0

    harness.dispatch({ tabId: TAB_ID, leafId: LEAF_ID, title: null })

    expect(harness.paneTitles.current).toEqual({})
    expect(harness.removePaneTitle).toHaveBeenCalledWith(7)
    expect(harness.titleWrites).toEqual([])
    // The clear must persist too, or the removed title returns on the next snapshot.
    expect(harness.persistLayoutSnapshot).toHaveBeenCalledTimes(2)
  })

  it('ignores another tab and an unresolvable leaf without touching any title', () => {
    const harness = createHarness()
    harness.dispatch({ tabId: TAB_ID, leafId: LEAF_ID, title: 'REVIEWER' })
    expect(harness.paneTitles.current).toEqual({ 7: 'REVIEWER' })

    harness.dispatch({ tabId: 'other-tab', leafId: LEAF_ID, title: 'NOPE' })
    harness.dispatch({ tabId: TAB_ID, leafId: OTHER_LEAF_ID, title: 'NOPE' })

    expect(harness.paneTitles.current).toEqual({ 7: 'REVIEWER' })
    expect(harness.persistLayoutSnapshot).toHaveBeenCalledTimes(1)
  })

  it('drops the removed-title marker when setting a title', () => {
    const harness = createHarness()
    harness.removedLeafIds.current.add(LEAF_ID)

    harness.dispatch({ tabId: TAB_ID, leafId: LEAF_ID, title: 'KEEP' })

    expect(harness.removedLeafIds.current.has(LEAF_ID)).toBe(false)
  })

  it('registers alongside the close listener and unregisters both', () => {
    const harness = createHarness()
    expect(harness.hasCloseListener()).toBe(true)
    expect(harness.hasTitleListener()).toBe(true)

    harness.uninstall()

    expect(harness.hasCloseListener()).toBe(false)
    expect(harness.hasTitleListener()).toBe(false)
  })
})
