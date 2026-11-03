import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import type { TerminalLeafIntoTabResult } from '../../../../shared/terminal-leaf-move'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'
import { moveTerminalTabIntoPane } from './terminal-tab-into-pane-move'
import { createJoinHarness } from './terminal-tab-into-pane-move-harness'
import { B, P_A, SOURCE, TARGET, WT } from './terminal-tab-into-pane-fixture'

// The window-applied path under test exists only while the layout-owner switch is off.
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

const mockApi = createStoreCascadesMockApi()
Object.assign(mockApi, { session: { closeTerminalSurface: vi.fn().mockResolvedValue(undefined) } })

const join = { sourceTabId: SOURCE, targetTabId: TARGET, side: 'right' } as const
const GROUP = 'group-target'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Detaches T's leaf B into a new tab, as a drag-out of one of T's panes would. */
function detachPaneOfTarget(store: ReturnType<typeof createTestStore>) {
  return detachTerminalPaneToTab({
    getStore: () => store.getState(),
    manager: {
      getPanes: () => [{ id: 1 }, { id: 2 }],
      getLeafId: () => B,
      detachPaneForExternalMove: () => true
    },
    persistLayoutSnapshot: vi.fn(),
    sourcePaneId: 1,
    sourceTabId: TARGET,
    targetGroupId: GROUP,
    worktreeId: WT
  })
}

let moveLeafToNewTab: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  moveLeafToNewTab = vi.fn(() => Promise.resolve({ status: 'refused', reason: 'pty_mismatch' }))
  vi.stubGlobal('window', {
    api: { pty: { moveLeafToNewTab }, worktrees: { updateMeta: vi.fn(() => Promise.resolve()) } }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function harness() {
  const h = createJoinHarness(createTestStore())
  h.store.setState({
    groupsByWorktree: {
      [WT]: [
        { id: GROUP, worktreeId: WT, activeTabId: TARGET, tabOrder: [TARGET], recentTabIds: [] }
      ]
    }
  })
  return h
}

describe('a join into a tab and a detach out of it are mutually exclusive', () => {
  it('join first: a detach of one of the target tab panes never reaches IPC', async () => {
    const h = harness()
    const reply = deferred<TerminalLeafIntoTabResult>()
    h.answerWith(() => reply.promise)

    const joining = moveTerminalTabIntoPane(join, h.deps)
    await Promise.resolve()
    expect(h.requests).toHaveLength(1)
    await expect(detachPaneOfTarget(h.store)).resolves.toBeNull()
    reply.resolve({ status: 'moved', ptyId: P_A, sourceTabClosed: true })
    await joining

    expect(moveLeafToNewTab).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(1)
  })

  it('detach first: a join into that tab never reaches IPC', async () => {
    const h = harness()
    const reply = deferred<{ status: 'refused'; reason: 'pty_mismatch' }>()
    moveLeafToNewTab.mockReturnValue(reply.promise)

    const detaching = detachPaneOfTarget(h.store)
    await Promise.resolve()
    expect(moveLeafToNewTab).toHaveBeenCalledTimes(1)
    await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('refused')
    reply.resolve({ status: 'refused', reason: 'pty_mismatch' })
    await detaching

    expect(h.requests).toHaveLength(0)
    expect(moveLeafToNewTab).toHaveBeenCalledTimes(1)
  })

  it('releases every key once both replies are in, so a later move runs', async () => {
    const h = harness()

    await detachPaneOfTarget(h.store)
    await expect(moveTerminalTabIntoPane(join, h.deps)).resolves.toBe('moved')

    expect(h.requests).toHaveLength(1)
  })
})
