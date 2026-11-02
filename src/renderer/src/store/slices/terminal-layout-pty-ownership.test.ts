import { beforeEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import {
  resetAgentPaneAuthorityAliasesForTests,
  resolveAgentPaneAuthorityKey
} from './agent-pane-authority'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'

describe('setTabLayout PTY ownership', () => {
  beforeEach(() => {
    resetAgentPaneAuthorityAliasesForTests()
  })

  it('normalizes duplicate PTY surfaces at the renderer state boundary', () => {
    const store = createTestStore()

    store.getState().setTabLayout('tab-1', {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-agent'
      }
    })

    expect(store.getState().terminalLayoutsByTabId['tab-1']).toEqual({
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'pty-agent' }
    })
  })

  it('preserves valid live layouts and legacy leaf ids by identity', () => {
    const store = createTestStore()
    const layout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, leafId: 'pane:1' },
        second: { type: 'leaf' as const, leafId: 'pane:2' }
      },
      activeLeafId: 'pane:2',
      expandedLeafId: 'pane:1',
      ptyIdsByLeafId: {
        'pane:1': 'pty-local',
        'pane:2': 'remote:env-1@@term_remote'
      }
    }

    store.getState().setTabLayout('tab-1', layout)

    expect(store.getState().terminalLayoutsByTabId['tab-1']).toBe(layout)
  })

  it('moves live and future pane authority onto the retained PTY leaf', () => {
    const store = createTestStore()
    const removedPaneKey = makePaneKey('tab-1', LEAF_1)
    const retainedPaneKey = makePaneKey('tab-1', LEAF_2)
    store.getState().setAgentStatus(removedPaneKey, {
      state: 'working',
      prompt: 'before repair',
      agentType: 'codex'
    })

    store.getState().setTabLayout('tab-1', {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-agent'
      }
    })

    expect(store.getState().agentStatusByPaneKey[removedPaneKey]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[retainedPaneKey]?.prompt).toBe('before repair')
    expect(resolveAgentPaneAuthorityKey(removedPaneKey)).toBe(retainedPaneKey)

    store.getState().setAgentStatus(removedPaneKey, {
      state: 'working',
      prompt: 'after repair',
      agentType: 'codex'
    })
    expect(store.getState().agentStatusByPaneKey[retainedPaneKey]?.prompt).toBe('after repair')
  })

  it('moves hydrated pane authority onto the retained PTY leaf', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/wt-1'
    const removedPaneKey = makePaneKey('tab-1', LEAF_1)
    const retainedPaneKey = makePaneKey('tab-1', LEAF_2)
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/wt-1' })]
      }
    })
    store.getState().setAgentStatus(removedPaneKey, {
      state: 'working',
      prompt: 'before hydration',
      agentType: 'codex'
    })

    store.getState().hydrateWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabId: 'tab-1',
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-agent' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF_1 },
            second: { type: 'leaf', leafId: LEAF_2 }
          },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [LEAF_1]: 'pty-agent',
            [LEAF_2]: 'pty-agent'
          }
        }
      }
    })

    expect(store.getState().agentStatusByPaneKey[removedPaneKey]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[retainedPaneKey]?.prompt).toBe('before hydration')
    expect(resolveAgentPaneAuthorityKey(removedPaneKey)).toBe(retainedPaneKey)
  })

  it('does not steal authority from a pane that was already detached to another tab', () => {
    const store = createTestStore()
    const removedPaneKey = makePaneKey('source-tab', LEAF_1)
    const retainedPaneKey = makePaneKey('source-tab', LEAF_2)
    const detachedPaneKey = makePaneKey('target-tab', LEAF_1)
    store.getState().setTabLayout('target-tab', {
      root: { type: 'leaf', leafId: LEAF_1 },
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-detached' }
    })
    store.getState().transferAgentPaneAuthority({
      fromPaneKey: removedPaneKey,
      toPaneKey: detachedPaneKey,
      ptyId: 'pty-detached'
    })

    store.getState().setTabLayout('source-tab', {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-detached',
        [LEAF_2]: 'pty-detached'
      }
    })

    expect(resolveAgentPaneAuthorityKey(removedPaneKey)).toBe(detachedPaneKey)
    expect(resolveAgentPaneAuthorityKey(detachedPaneKey)).toBe(detachedPaneKey)
    expect(resolveAgentPaneAuthorityKey(retainedPaneKey)).toBe(retainedPaneKey)
  })

  it('repairs duplicate legacy leaf ownership without throwing', () => {
    const store = createTestStore()

    expect(() =>
      store.getState().setTabLayout('tab-1', {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'pane:1' },
          second: { type: 'leaf', leafId: 'pane:2' }
        },
        activeLeafId: 'pane:2',
        expandedLeafId: null,
        ptyIdsByLeafId: {
          'pane:1': 'pty-agent',
          'pane:2': 'pty-agent'
        }
      })
    ).not.toThrow()
    expect(store.getState().terminalLayoutsByTabId['tab-1']).toEqual({
      root: { type: 'leaf', leafId: 'pane:2' },
      activeLeafId: 'pane:2',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'pane:2': 'pty-agent' }
    })
  })

  it('scopes ownership to a tab so detach handoffs can share a PTY across tabs', () => {
    const store = createTestStore()
    const sourceLayout = {
      root: { type: 'leaf' as const, leafId: LEAF_1 },
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-detached' }
    }
    const targetLayout = {
      root: { type: 'leaf' as const, leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'pty-detached' }
    }

    store.getState().setTabLayout('source-tab', sourceLayout)
    store.getState().setTabLayout('target-tab', targetLayout)

    expect(store.getState().terminalLayoutsByTabId['source-tab']).toBe(sourceLayout)
    expect(store.getState().terminalLayoutsByTabId['target-tab']).toBe(targetLayout)
  })
})
