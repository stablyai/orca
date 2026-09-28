import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { createTestStore, makeWorktree, seedStore } from '../slices/store-test-helpers'

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

describe('renaming a terminal tab still resolves', () => {
  it('routes a terminal rename through its entityId, not the unified id', () => {
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

    const tabs = store.getState().unifiedTabsByWorktree[WORKTREE] ?? []
    expect(tabs.find((t) => t.id === TERMINAL_UNIFIED_ID)?.customLabel).toBe('Build logs')
    expect(tabs.find((t) => t.id === STRUCTURED_TAB_ID)?.customLabel).toBeNull()
  })
})

describe('recoloring a structured chat tab', () => {
  it('writes the color onto the agent-session tab', () => {
    const store = storeWithStructuredTab()
    store.getState().setTabColor(STRUCTURED_TAB_ID, 'red')
    expect(colorOf(store)).toBe('red')
  })
})

describe('renaming a structured chat tab', () => {
  it('writes the custom label onto the agent-session tab', () => {
    const store = storeWithStructuredTab()
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, 'Flaky retry test')
    expect(labelOf(store)).toBe('Flaky retry test')
  })

  it('clears the custom label when the rename is emptied', () => {
    const store = storeWithStructuredTab()
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, 'Flaky retry test')
    // Guard: without the intermediate assertion this case passes on a rename
    // that never wrote anything, since the label starts out null too.
    expect(labelOf(store)).toBe('Flaky retry test')
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, null)
    expect(labelOf(store)).toBeNull()
  })
})
