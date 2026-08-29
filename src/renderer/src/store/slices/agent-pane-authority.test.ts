import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  countAgentPaneAuthorityAliasesForTests,
  forgetAgentPaneAuthorityAliasesByTabIds,
  resetAgentPaneAuthorityAliasesForTests,
  resolveAgentPaneAuthorityKey,
  transferAgentPaneAuthorityAlias
} from './agent-pane-authority'
import { createTestStore } from './store-test-helpers'

const SOURCE = makePaneKey('tab-source', '11111111-1111-4111-8111-111111111111')
const TARGET = makePaneKey('tab-target', '22222222-2222-4222-8222-222222222222')
const FINAL = makePaneKey('tab-final', '33333333-3333-4333-8333-333333333333')
const SIBLING = makePaneKey('tab-target', '44444444-4444-4444-8444-444444444444')

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

  // STA-4114: the renderer tombstone outlived the detach/reattach cycle, so a pane
  // that was still running never showed status again for the rest of its life.
  it('lifts the retirement fence on re-attach so an in-flight turn can still report done', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(TARGET, { state: 'working', prompt: 'turn in flight' })
    store.getState().retireAgentPaneAuthority(TARGET)

    // The pane re-attached mid-turn: the agent never starts a NEW turn, it only
    // finishes the one already running, so a turn-triggered revival cannot fire.
    store.getState().setAgentStatus(TARGET, { state: 'done', prompt: 'turn in flight' })
    expect(store.getState().agentStatusByPaneKey[TARGET]).toBeUndefined()

    store.getState().restoreAgentPaneAuthority(TARGET)
    expect(store.getState().recentlyRetiredAgentStatusPaneKeys[TARGET]).toBeUndefined()
    expect(restorePaneAuthority).toHaveBeenCalledWith(TARGET)

    store.getState().setAgentStatus(TARGET, { state: 'done', prompt: 'turn in flight' })
    expect(store.getState().agentStatusByPaneKey[TARGET]?.state).toBe('done')
  })

  it('re-opens a pane re-attached while idle for a turn that starts much later', () => {
    const store = createTestStore()
    store.getState().retireAgentPaneAuthority(TARGET)
    store.getState().restoreAgentPaneAuthority(TARGET)

    store.getState().setAgentStatus(TARGET, { state: 'working', prompt: 'much later turn' })
    expect(store.getState().agentStatusByPaneKey[TARGET]?.state).toBe('working')
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

  it('leaves sibling panes untouched when one pane is restored', () => {
    const store = createTestStore()
    store.getState().retireAgentPaneAuthority(TARGET)
    store.getState().retireAgentPaneAuthority(SIBLING)

    store.getState().restoreAgentPaneAuthority(TARGET)

    expect(store.getState().recentlyRetiredAgentStatusPaneKeys[TARGET]).toBeUndefined()
    expect(store.getState().recentlyRetiredAgentStatusPaneKeys[SIBLING]).toBe(true)
    store.getState().setAgentStatus(SIBLING, { state: 'working', prompt: 'still fenced' })
    expect(store.getState().agentStatusByPaneKey[SIBLING]).toBeUndefined()
  })

  it('can retire live pane authority while retaining a migration recovery fence', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(TARGET, { state: 'working', prompt: 'target' })
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
          updatedAt: 1,
          automaticResumeBlockedBy: 'legacy-orchestration-worker'
        }
      }
    })

    store.getState().retireAgentPaneAuthority(TARGET, { preserveSleepingAgentSession: true })

    const state = store.getState()
    expect(state.agentStatusByPaneKey[TARGET]).toBeUndefined()
    expect(state.agentLaunchConfigByPaneKey[TARGET]).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[TARGET]).toMatchObject({
      automaticResumeBlockedBy: 'legacy-orchestration-worker'
    })
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
    expect(resolveAgentPaneAuthorityKey(TARGET)).toBe(FINAL)
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

  it('forgets aliases for purged tabs and caps unbounded detach churn', () => {
    const leafId = '66666666-6666-4666-8666-666666666666'
    transferAgentPaneAuthorityAlias({
      fromPaneKey: makePaneKey('tab-purged', leafId),
      toPaneKey: makePaneKey('tab-kept', leafId),
      ptyId: 'pty-1'
    })
    expect(countAgentPaneAuthorityAliasesForTests()).toBe(1)

    forgetAgentPaneAuthorityAliasesByTabIds(['tab-kept'])
    expect(countAgentPaneAuthorityAliasesForTests()).toBe(0)

    // Why: pty exit and workspace purge do not retire, so the cap is the backstop.
    for (let index = 0; index < 600; index += 1) {
      transferAgentPaneAuthorityAlias({
        fromPaneKey: makePaneKey(`tab-from-${index}`, leafId),
        toPaneKey: makePaneKey(`tab-to-${index}`, leafId),
        ptyId: `pty-${index}`
      })
    }
    expect(countAgentPaneAuthorityAliasesForTests()).toBeLessThanOrEqual(512)
    expect(resolveAgentPaneAuthorityKey(makePaneKey('tab-from-599', leafId))).toBe(
      makePaneKey('tab-to-599', leafId)
    )
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
