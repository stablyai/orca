import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../store/types'
import { createTestStore } from '../../store/slices/store-test-helpers'
import { buildMobileSessionTabSnapshots } from './mobile-session-snapshots'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const WT = 'repo1::/tmp/feature'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function publishedTerminalRows(state: AppState) {
  return buildMobileSessionTabSnapshots(state)
    .flatMap((snapshot) => snapshot.tabs)
    .flatMap((tab) =>
      tab.type === 'terminal'
        ? [{ leafId: tab.leafId, viewMode: tab.viewMode, owner: tab.parentLayout?.chatLeafId }]
        : []
    )
}

describe('desktop publication of a terminal tab view', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    // @ts-expect-error -- partial window stub is sufficient for these store-only tests
    globalThis.window = { api: { ui: { set: vi.fn() } } }
    store = createTestStore()
  })

  it('publishes the view a tab was created in', () => {
    const tab = store.getState().createTab(WT, undefined, undefined, {
      viewMode: 'chat',
      launchAgent: 'claude',
      initialPtyId: 'pty-1',
      initialLeafId: LEAF_A
    })

    expect(store.getState().tabsByWorktree[WT]?.[0]?.viewMode).toBe('chat')
    expect(publishedTerminalRows(store.getState())).toEqual([
      { leafId: LEAF_A, viewMode: 'chat', owner: undefined }
    ])
    store.getState().applyTerminalChatPair(tab.id, null, 'terminal')
    expect(publishedTerminalRows(store.getState())).toEqual([
      { leafId: LEAF_A, viewMode: 'terminal', owner: undefined }
    ])
  })

  it('publishes a restored view held only by the unified tab', () => {
    const tab = store.getState().createTab(WT, undefined, undefined, {
      initialPtyId: 'pty-1',
      initialLeafId: LEAF_A
    })
    const state = store.getState()
    store.setState({
      unifiedTabsByWorktree: {
        [WT]: state.unifiedTabsByWorktree[WT]!.map((unified) =>
          unified.entityId === tab.id ? { ...unified, viewMode: 'chat' as const } : unified
        )
      }
    })
    expect(store.getState().tabsByWorktree[WT]?.[0]?.viewMode).toBeUndefined()
    expect(publishedTerminalRows(store.getState())).toEqual([
      { leafId: LEAF_A, viewMode: 'chat', owner: undefined }
    ])
  })

  it('publishes a restored chat whose owner left the tree as terminal, without the owner', () => {
    const tab = store.getState().createTab(WT, undefined, undefined, {
      viewMode: 'chat',
      initialPtyId: 'pty-1',
      initialLeafId: LEAF_A
    })
    store.setState({
      terminalLayoutsByTabId: {
        [tab.id]: {
          ...store.getState().terminalLayoutsByTabId[tab.id]!,
          chatLeafId: LEAF_B
        }
      }
    })
    expect(publishedTerminalRows(store.getState())).toEqual([
      { leafId: LEAF_A, viewMode: 'terminal', owner: undefined }
    ])
  })
})
