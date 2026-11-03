import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { moveTerminalTabIntoPane } from './terminal-tab-into-pane-move'
import { createJoinHarness } from './terminal-tab-into-pane-move-harness'
import { mergeCapturedLeafState } from './merge-captured-leaf-state'
import { A, B, C, SOURCE, TARGET, targetLayout } from './terminal-tab-into-pane-fixture'

// The window-applied join under test exists only while the layout-owner switch is off.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

const mockApi = createStoreCascadesMockApi()
Object.assign(mockApi, { session: { closeTerminalSurface: vi.fn().mockResolvedValue(undefined) } })

const join = { sourceTabId: SOURCE, targetTabId: TARGET, side: 'right' } as const

beforeEach(() => {
  vi.clearAllMocks()
})

/** Gives the moved leaf A a title, a buffer and a scrollback ref in S, as a used pane has. */
function seedMovedPaneState(h: ReturnType<typeof createJoinHarness>): void {
  h.store.setState((s) => ({
    terminalLayoutsByTabId: {
      ...s.terminalLayoutsByTabId,
      [SOURCE]: {
        ...s.terminalLayoutsByTabId[SOURCE]!,
        titlesByLeafId: { [A]: 'My build' },
        buffersByLeafId: { [A]: 'buffer-a' },
        scrollbackRefsByLeafId: { [A]: 'scrollback-ref-a' }
      }
    }
  }))
}

/**
 * Collapsing makes the mounted pane save what it can see (persistLayoutSnapshot): the mounted
 * tree and the title, buffer and scrollback entries of the mounted leaves only.
 */
function collapseSavesMountedTree(h: ReturnType<typeof createJoinHarness>): void {
  const collapse = h.deps.dispatchToggleExpand
  h.deps.dispatchToggleExpand = (tabId) => {
    collapse(tabId)
    const existing = h.store.getState().terminalLayoutsByTabId[tabId]
    if (!existing) {
      return
    }
    const mounted = new Set(h.deps.mountedLeafIds(tabId) ?? [])
    const saved = {
      ...existing,
      root: targetLayout().root,
      ptyIdsByLeafId: mergeCapturedLeafState({
        prior: existing.ptyIdsByLeafId,
        fresh: {},
        currentLeafIds: mounted
      }),
      buffersByLeafId: mergeCapturedLeafState({
        prior: existing.buffersByLeafId,
        fresh: {},
        currentLeafIds: mounted
      }),
      scrollbackRefsByLeafId: mergeCapturedLeafState({
        prior: existing.scrollbackRefsByLeafId,
        fresh: {},
        currentLeafIds: mounted
      }),
      titlesByLeafId: Object.fromEntries(
        Object.entries(existing.titlesByLeafId ?? {}).filter(([leafId]) => mounted.has(leafId))
      )
    }
    h.store.getState().setTabLayout(tabId, saved)
  }
}

describe('joining into a mounted target tab', () => {
  it('an expanded target is collapsed before the graft is saved: the moved pane keeps its state', async () => {
    const h = createJoinHarness(createTestStore())
    seedMovedPaneState(h)
    h.store.setState({ expandedPaneByTabId: { [TARGET]: true } })
    collapseSavesMountedTree(h)

    await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('moved')

    expect(h.calls.indexOf(`toggleExpand:${TARGET}`)).toBeLessThan(
      h.calls.indexOf(`setTabLayout:${TARGET}`)
    )
    const layout = h.store.getState().terminalLayoutsByTabId[TARGET]
    expect(layout?.titlesByLeafId?.[A]).toBe('My build')
    expect(layout?.buffersByLeafId?.[A]).toBe('buffer-a')
    expect(layout?.scrollbackRefsByLeafId?.[A]).toBe('scrollback-ref-a')
    expect(layout?.ptyIdsByLeafId).toMatchObject({ [A]: 'pty-a', [B]: 'pty-b', [C]: 'pty-c' })
  })

  it('shows the moved pane title right after the split, not only after a remount', async () => {
    const h = createJoinHarness(createTestStore())
    seedMovedPaneState(h)

    await moveTerminalTabIntoPane(join, h.deps)

    expect(h.titleEvents).toEqual([{ tabId: TARGET, leafId: A, title: 'My build' }])
    expect(h.calls.indexOf('title')).toBeGreaterThan(h.calls.indexOf('split'))
  })

  it('sends no title event when the moved pane has no title', async () => {
    const h = createJoinHarness(createTestStore())

    await moveTerminalTabIntoPane(join, h.deps)

    expect(h.titleEvents).toEqual([])
  })

  it('sends no title event when the split did not mount the pane (the remount shows it)', async () => {
    const h = createJoinHarness(createTestStore(), { dispatchSplit: () => undefined })
    seedMovedPaneState(h)

    await moveTerminalTabIntoPane(join, h.deps)

    expect(h.titleEvents).toEqual([])
    expect(h.remount).toHaveBeenCalledTimes(1)
  })
})
