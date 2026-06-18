import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/path/wt1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function seedWorktree(store: ReturnType<typeof createTestStore>, enabled: boolean): string {
  seedStore(store, {
    settings: {
      ...getDefaultSettings('/tmp'),
      tabAutoGenerateTitle: enabled
    },
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  return store.getState().createTab(WORKTREE_ID).id
}

describe('generated agent tab titles', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays disabled by default when agent prompts arrive', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, false)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Refactor the auth middleware',
      agentType: 'codex'
    })

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBeUndefined()
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBeUndefined()
  })

  it('generates one stable title from the first known agent prompt when enabled', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Can you please refactor the auth middleware to use JWT tokens?',
      agentType: 'codex'
    })
    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Replace this with a later task name',
      agentType: 'codex'
    })

    expect(store.getState().tabsByWorktree[WORKTREE_ID][0].generatedTitle).toBe(
      'Refactor the auth middleware to use JWT'
    )
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID][0].generatedLabel).toBe(
      'Refactor the auth middleware to use JWT'
    )
  })

  it('keeps manual rename precedence over generated and live titles', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    const tabId = seedWorktree(store, true)

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Fix the flaky status tests',
      agentType: 'claude'
    })
    store.getState().updateTabTitle(tabId, 'Claude working')
    store.getState().setTabCustomTitle(tabId, 'Status tests')

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(resolveTerminalTabTitle(tab, true)).toBe('Status tests')
    expect(tab.generatedTitle).toBe('Fix the flaky status tests')
  })

  it('does not generate a title for quick command labeled tabs', () => {
    vi.useFakeTimers()
    const store = createTestStore()
    seedStore(store, {
      settings: {
        ...getDefaultSettings('/tmp'),
        tabAutoGenerateTitle: true
      },
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
      }
    })
    const tabId = store
      .getState()
      .createTab(WORKTREE_ID, undefined, undefined, { quickCommandLabel: 'Run tests' }).id

    store.getState().setAgentStatus(makePaneKey(tabId, LEAF_ID), {
      state: 'working',
      prompt: 'Fix the flaky status tests',
      agentType: 'claude'
    })

    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(tab.generatedTitle).toBeUndefined()
    expect(resolveTerminalTabTitle(tab, true)).toBe('Run tests')
  })
})
