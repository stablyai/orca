import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  resetAgentPaneAuthorityAliasesForTests,
  resolveAgentPaneAuthorityKey
} from './agent-pane-authority'
import { createTestStore } from './store-test-helpers'

const SOURCE = makePaneKey('tab-source', '11111111-1111-4111-8111-111111111111')
const TARGET = makePaneKey('tab-target', '22222222-2222-4222-8222-222222222222')
const FINAL = makePaneKey('tab-final', '33333333-3333-4333-8333-333333333333')
const SIBLING = makePaneKey('tab-target', '44444444-4444-4444-8444-444444444444')

const retirePaneAuthority = vi.fn()
const transferPaneAuthority = vi.fn()
const dropByTabPrefix = vi.fn()

beforeEach(() => {
  resetAgentPaneAuthorityAliasesForTests()
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      agentStatus: {
        retirePaneAuthority,
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
  it('retires one pane, clears resume authority, and rejects late status without harming siblings', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(TARGET, { state: 'working', prompt: 'target' })
    store.getState().setAgentStatus(SIBLING, { state: 'working', prompt: 'sibling' })
    store.getState().registerAgentLaunchConfig(TARGET, { agentArgs: '', agentEnv: {} })
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        [TARGET]: {
          paneKey: TARGET,
          tabId: 'tab-target',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })

    store.getState().retireAgentPaneAuthority(TARGET)
    store.getState().setAgentStatus(TARGET, { state: 'done', prompt: 'late' })

    const state = store.getState()
    expect(state.agentStatusByPaneKey[TARGET]).toBeUndefined()
    expect(state.agentLaunchConfigByPaneKey[TARGET]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[TARGET]).toBeUndefined()
    expect(state.agentStatusByPaneKey[SIBLING]).toBeDefined()
    expect(state.recentlyRetiredAgentStatusPaneKeys[TARGET]).toBe(true)
    expect(retirePaneAuthority).toHaveBeenCalledWith(TARGET)
  })

  it('keeps a physical pane routed through chained detaches until its current owner closes', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(SOURCE, { state: 'working', prompt: 'source' })
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        [SOURCE]: {
          paneKey: SOURCE,
          tabId: 'tab-source',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })

    store
      .getState()
      .transferAgentPaneAuthority({ fromPaneKey: SOURCE, toPaneKey: TARGET, ptyId: 'pty-1' })
    store
      .getState()
      .transferAgentPaneAuthority({ fromPaneKey: TARGET, toPaneKey: FINAL, ptyId: 'pty-1' })
    store.getState().dropAgentStatusByTabPrefix('tab-source')

    expect(resolveAgentPaneAuthorityKey(SOURCE)).toBe(FINAL)
    expect(store.getState().sleepingAgentSessionsByPaneKey[FINAL]).toMatchObject({
      paneKey: FINAL,
      tabId: 'tab-final',
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    store.getState().setAgentStatus(SOURCE, { state: 'working', prompt: 'after source close' })
    expect(store.getState().agentStatusByPaneKey[FINAL]?.prompt).toBe('after source close')
    expect(transferPaneAuthority).toHaveBeenNthCalledWith(1, {
      fromPaneKey: SOURCE,
      toPaneKey: TARGET,
      ptyId: 'pty-1'
    })
    expect(transferPaneAuthority).toHaveBeenNthCalledWith(2, {
      fromPaneKey: TARGET,
      toPaneKey: FINAL,
      ptyId: 'pty-1'
    })

    store.getState().dropAgentStatusByTabPrefix('tab-final')
    store.getState().setAgentStatus(SOURCE, { state: 'done', prompt: 'too late' })

    expect(store.getState().agentStatusByPaneKey[SOURCE]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[FINAL]).toBeUndefined()
    expect(store.getState().recentlyRetiredAgentStatusPaneKeys[SOURCE]).toBe(true)
  })
})
