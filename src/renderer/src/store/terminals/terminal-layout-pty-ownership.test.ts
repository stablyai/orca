import { beforeEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import '../../../../shared/constants'
import {
  resetAgentPaneAuthorityAliasesForTests,
  resolveAgentPaneAuthorityKey
} from '../slices/agent-status/agent-pane-authority'
import { createTestStore } from '../testing/app-store-test-fixture'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'

describe('setTabLayout PTY ownership', () => {
  beforeEach(() => {
    resetAgentPaneAuthorityAliasesForTests()
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

    expect(store.getState().agentStatusByPaneKey.get(removedPaneKey)).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey.get(retainedPaneKey)?.prompt).toBe('before repair')
    expect(resolveAgentPaneAuthorityKey(removedPaneKey)).toBe(retainedPaneKey)

    store.getState().setAgentStatus(removedPaneKey, {
      state: 'working',
      prompt: 'after repair',
      agentType: 'codex'
    })
    expect(store.getState().agentStatusByPaneKey.get(retainedPaneKey)?.prompt).toBe('after repair')
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
})
