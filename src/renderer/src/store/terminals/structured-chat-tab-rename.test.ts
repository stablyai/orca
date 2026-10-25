import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { createTestStore, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

const WORKTREE = 'local-repo::/tmp/app'
const STRUCTURED_TAB_ID = 'structured-agent-session-codex-1'

function structuredTab(): Tab {
  return {
    id: STRUCTURED_TAB_ID,
    entityId: 'codex-1',
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

const TERMINAL_TAB_ID = 'terminal-1'
const TERMINAL_UNIFIED_ID = 'unified-terminal-1'

function terminalTab(): Tab {
  return {
    id: TERMINAL_UNIFIED_ID,
    entityId: TERMINAL_TAB_ID,
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 1,
    createdAt: 2
  }
}

function storeWithStructuredTab(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    repos: [{ id: 'local-repo', path: '/tmp/app', name: 'app' }] as never,
    worktreesByRepo: {
      'local-repo': [makeWorktree({ id: WORKTREE, repoId: 'local-repo', path: '/tmp/app' })]
    },
    unifiedTabsByWorktree: { [WORKTREE]: [structuredTab()] }
  })
  return store
}

function labelOf(store: ReturnType<typeof createTestStore>): string | null | undefined {
  return store
    .getState()
    .unifiedTabsByWorktree[WORKTREE]?.find((tab) => tab.id === STRUCTURED_TAB_ID)?.customLabel
}

function colorOf(store: ReturnType<typeof createTestStore>): string | null | undefined {
  return store
    .getState()
    .unifiedTabsByWorktree[WORKTREE]?.find((tab) => tab.id === STRUCTURED_TAB_ID)?.color
}

/** A layout-owner build sends the change to main, whose frame draws it; otherwise the window does. */
function expectChange(windowShows: () => void, mainGets: Record<string, unknown>): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    expect(layoutApplyTestTransport.sent.at(-1)).toEqual(
      expect.objectContaining({ workspace: WORKTREE, ...mainGets })
    )
  } else {
    windowShows()
  }
}

describe('renaming a terminal tab still resolves', () => {
  it('routes a terminal rename through its entityId, not the unified id', async () => {
    const store = createTestStore()
    seedStore(store, {
      repos: [{ id: 'local-repo', path: '/tmp/app', name: 'app' }] as never,
      worktreesByRepo: {
        'local-repo': [makeWorktree({ id: WORKTREE, repoId: 'local-repo', path: '/tmp/app' })]
      },
      unifiedTabsByWorktree: { [WORKTREE]: [terminalTab(), structuredTab()] }
    })

    // Keyed by the TERMINAL's entityId — the structured tab must not absorb it.
    store.getState().setTabCustomTitle(TERMINAL_TAB_ID, 'Build logs')
    await layoutApplyTestTransport.settle()

    const tabs = store.getState().unifiedTabsByWorktree[WORKTREE] ?? []
    expectChange(
      () => expect(tabs.find((t) => t.id === TERMINAL_UNIFIED_ID)?.customLabel).toBe('Build logs'),
      { type: 'renameTab', tabId: TERMINAL_UNIFIED_ID, title: 'Build logs' }
    )
    expect(tabs.find((t) => t.id === STRUCTURED_TAB_ID)?.customLabel).toBeNull()
  })
})

describe('recoloring a structured chat tab', () => {
  it('writes the color onto the agent-session tab', async () => {
    const store = storeWithStructuredTab()
    store.getState().setTabColor(STRUCTURED_TAB_ID, 'red')
    await layoutApplyTestTransport.settle()
    expectChange(() => expect(colorOf(store)).toBe('red'), {
      type: 'setTabProps',
      tabId: STRUCTURED_TAB_ID,
      color: 'red'
    })
  })
})

describe('renaming a structured chat tab', () => {
  it('clears the custom label when the rename is emptied', async () => {
    const store = storeWithStructuredTab()
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, 'Flaky retry test')
    await layoutApplyTestTransport.settle()
    // Guard: without the intermediate assertion this case passes on a rename
    // that never wrote anything, since the label starts out null too.
    expectChange(() => expect(labelOf(store)).toBe('Flaky retry test'), {
      type: 'renameTab',
      tabId: STRUCTURED_TAB_ID,
      title: 'Flaky retry test'
    })
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, null)
    await layoutApplyTestTransport.settle()
    expectChange(() => expect(labelOf(store)).toBeNull(), {
      type: 'renameTab',
      tabId: STRUCTURED_TAB_ID,
      title: null
    })
  })
})
