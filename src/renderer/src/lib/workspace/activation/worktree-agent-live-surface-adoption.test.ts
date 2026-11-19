import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from '../../../store/slices/tabs/tabs-slice-test-harness'
import { createTestStore } from '../../../store/testing/app-store-test-fixture'
import type { LiveTerminalSurfaceOwnerIndex } from '../ownership/worktree-live-terminal-surface-owners'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

const { adoptLiveWorkspacePtySurfaces } = await import('./worktree-agent-live-surface-adoption')

const WT = 'repo1::/tmp/feature'
const TAB_X = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const TAB_Z = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const LEAF_L = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const ORIGINAL = `${WT}@@orig0059`
const REPLACEMENT = `${WT}@@repl0057`

let store: ReturnType<typeof createTestStore>

beforeEach(() => {
  store = createTestStore()
  // An older build restarted a shell in tab X's pane while this build's original kept running.
  store.getState().createTab(WT, undefined, undefined, {
    id: TAB_X,
    initialLeafId: LEAF_L,
    initialPtyId: REPLACEMENT,
    recordInteraction: false
  })
  store
    .getState()
    .createTab(WT, undefined, undefined, { id: TAB_Z, activate: false, recordInteraction: false })
})

function owners(recordedTabId: string): LiveTerminalSurfaceOwnerIndex {
  return new Map([
    [REPLACEMENT, { tabId: TAB_X, paneKey: `${TAB_X}:${LEAF_L}`, ptyId: REPLACEMENT }],
    [
      ORIGINAL,
      {
        unowned: true as const,
        recorded: { tabId: recordedTabId, paneKey: `${recordedTabId}:${LEAF_L}`, ptyId: ORIGINAL }
      }
    ]
  ])
}

const terminalTabs = () => store.getState().tabsByWorktree[WT] ?? []
const tabOrder = () => store.getState().groupsByWorktree[WT]?.[0]?.tabOrder

describe('a live terminal whose recorded pane another terminal took over', () => {
  it('keeps both shells and shows the original right after that tab, once', async () => {
    for (let pass = 0; pass < 2; pass++) {
      await adoptLiveWorkspacePtySurfaces(store.getState, WT, [REPLACEMENT, ORIGINAL], async () =>
        owners(TAB_X)
      )
    }
    const recovered = terminalTabs().find((tab) => tab.ptyId === ORIGINAL)
    expect(terminalTabs()).toHaveLength(3)
    expect(tabOrder()).toEqual([TAB_X, recovered?.id, TAB_Z])
    expect(recovered?.defaultTitle).toBe('Recovered terminal')
    expect(store.getState().terminalLayoutsByTabId[TAB_X]?.ptyIdsByLeafId?.[LEAF_L]).toBe(
      REPLACEMENT
    )
    expect(store.getState().activeTabIdByWorktree[WT]).toBe(TAB_X)
  })

  it('keeps the numbered title when its recorded tab is gone', async () => {
    const gone = 'c56a4180-65aa-42ec-a945-5fd21dec0538'
    await adoptLiveWorkspacePtySurfaces(store.getState, WT, [REPLACEMENT, ORIGINAL], async () =>
      owners(gone)
    )
    const adopted = terminalTabs().find((tab) => tab.ptyId === ORIGINAL)
    expect(adopted?.defaultTitle).not.toBe('Recovered terminal')
  })
})
