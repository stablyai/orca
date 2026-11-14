import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import {
  resetAgentPaneAuthorityAliasesForTests,
  resolveAgentPaneAuthorityKey
} from './agent-pane-authority'
import { createTestStore } from '../../testing/app-store-test-fixture'

const SOURCE = makePaneKey('tab-source', '11111111-1111-4111-8111-111111111111')
const TARGET = makePaneKey('tab-target', '22222222-2222-4222-8222-222222222222')

const retirePaneAuthority = vi.fn()
const restorePaneAuthority = vi.fn()
const transferPaneAuthority = vi.fn()
const dropByTabPrefix = vi.fn()

beforeEach(() => {
  resetAgentPaneAuthorityAliasesForTests()
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      agentStatus: {
        retirePaneAuthority,
        restorePaneAuthority,
        transferPaneAuthority,
        dropByTabPrefix,
        drop: vi.fn()
      }
    }
  })
})

afterEach(() => {
  resetAgentPaneAuthorityAliasesForTests()
  vi.unstubAllGlobals()
})

describe('agent pane authority', () => {
  // Detach/reattach must lift renderer tombstones or still-running panes lose status permanently (STA-4114).
  it('lifts the retirement fence on re-attach so an in-flight turn can still report done', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(TARGET, { state: 'working', prompt: 'turn in flight' })
    store.getState().retireAgentPaneAuthority(TARGET)

    // Reattach mid-turn emits no new turn; revival cannot wait for one.
    store.getState().setAgentStatus(TARGET, { state: 'done', prompt: 'turn in flight' })
    expect(store.getState().agentStatusByPaneKey[TARGET]).toBeUndefined()

    store.getState().restoreAgentPaneAuthority(TARGET)
    expect(store.getState().recentlyRetiredAgentStatusPaneKeys[TARGET]).toBeUndefined()
    expect(restorePaneAuthority).toHaveBeenCalledWith(TARGET)

    store.getState().setAgentStatus(TARGET, { state: 'done', prompt: 'turn in flight' })
    expect(store.getState().agentStatusByPaneKey[TARGET]?.state).toBe('done')
  })

  it('does not lift a closed-tab tombstone on re-attach', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(TARGET, { state: 'working', prompt: 'before close' })
    store.getState().dropAgentStatusByTabPrefix('tab-target')

    store.getState().restoreAgentPaneAuthority(TARGET)
    expect(restorePaneAuthority).not.toHaveBeenCalled()

    store.getState().setAgentStatus(TARGET, { state: 'working', prompt: 'after close' })
    expect(store.getState().agentStatusByPaneKey[TARGET]).toBeUndefined()
  })

  it('clears the alias when a pane moves back to a key it previously left', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(SOURCE, { state: 'working', prompt: 'source' })

    store
      .getState()
      .transferAgentPaneAuthority({ fromPaneKey: SOURCE, toPaneKey: TARGET, ptyId: 'pty-1' })
    store
      .getState()
      .transferAgentPaneAuthority({ fromPaneKey: TARGET, toPaneKey: SOURCE, ptyId: 'pty-1' })

    expect(resolveAgentPaneAuthorityKey(SOURCE)).toBe(SOURCE)
    expect(resolveAgentPaneAuthorityKey(TARGET)).toBe(SOURCE)
    store.getState().setAgentStatus(SOURCE, { state: 'done', prompt: 'back home' })
    expect(store.getState().agentStatusByPaneKey[SOURCE]?.prompt).toBe('back home')
  })
})
