import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { observeAgentPresence } from '@/lib/agent-presence-transitions'

const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
const presence = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'boot:123' }
} as const

describe('host process ownership mirror', () => {
  it('survives turn dismissal and transport disappearance until the host reports exit', () => {
    const store = createTestStore()
    store
      .getState()
      .recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: 'ssh-a' })
    store.getState().removeAgentStatus(paneKey)
    store.getState().clearTransientAgentStatuses('ssh-a', 11)
    expect(store.getState().agentPresenceByPaneKey[paneKey]?.presence).toEqual(presence)
    store.getState().recordAgentPresence(paneKey, {
      presence: { ...presence, ended: true },
      receivedAt: 12,
      connectionId: 'ssh-a'
    })
    store
      .getState()
      .recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: 'ssh-a' })
    expect(store.getState().agentPresenceByPaneKey[paneKey]?.presence.ended).toBe(true)
  })

  it('commits ownership with a status batch and forgets it on explicit pane retirement', () => {
    const store = createTestStore()
    const initial = store.getState()
    initial.transactAgentStatuses((transaction) => {
      transaction
        .getState()
        .recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: null })
      expect(store.getState()).toBe(initial)
      expect(transaction.getState().agentPresenceByPaneKey[paneKey]?.presence).toEqual(presence)
    })
    store.getState().retireAgentPaneAuthority(paneKey)
    expect(store.getState().agentPresenceByPaneKey[paneKey]).toBeUndefined()
  })
  it('drops owner-only records when their pane or workspace is explicitly removed', () => {
    const store = createTestStore()
    store.getState().recordAgentPresence(paneKey, { presence, receivedAt: 10, worktreeId: 'wt-1' })
    store.getState().dropAgentStatus(paneKey)
    expect(store.getState().agentPresenceByPaneKey[paneKey]).toBeDefined()
    store.getState().dropAgentStatus(paneKey, { paneRemoved: true })
    expect(store.getState().agentPresenceByPaneKey[paneKey]).toBeUndefined()
    store.getState().recordAgentPresence(paneKey, { presence, receivedAt: 11, worktreeId: 'wt-1' })
    store
      .getState()
      .recordAgentPresence('other:leaf', { presence, receivedAt: 11, worktreeId: 'wt-2' })
    store.getState().dropAgentStatusByWorktree('wt-1')
    expect(store.getState().agentPresenceByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().agentPresenceByPaneKey['other:leaf']).toBeDefined()
  })

  it('drops only the released owner, never a replacement', () => {
    const store = createTestStore()
    store.getState().recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: null })
    const replacement = { ...presence, process: { ...presence.process, pid: 4002 } }
    store.getState().releaseAgentPresence(paneKey, replacement.process)
    expect(store.getState().agentPresenceByPaneKey[paneKey]?.presence).toEqual(presence)
    store.getState().releaseAgentPresence(paneKey, presence.process)
    expect(store.getState().agentPresenceByPaneKey[paneKey]).toBeUndefined()
  })

  it('lets terminal and host clears remove a live owner row, as without presence', () => {
    const store = createTestStore()
    store.getState().recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: null })
    store
      .getState()
      .setAgentStatus(paneKey, { state: 'working', prompt: 'task', agentType: 'claude' })
    store.getState().removeAgentStatus(paneKey)
    expect(store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().agentPresenceByPaneKey[paneKey]?.presence).toEqual(presence)
  })

  it('ignores a republished owner: no store write, epoch bump or listener call', () => {
    const store = createTestStore()
    const listener = vi.fn()
    const stop = observeAgentPresence(paneKey, listener)
    store.getState().recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: null })
    const recorded = store.getState()
    for (let i = 11; i < 21; i += 1) {
      store.getState().recordAgentPresence(paneKey, {
        presence: { ...presence, process: { ...presence.process } },
        receivedAt: i,
        connectionId: null
      })
    }
    expect(store.getState().agentPresenceByPaneKey).toBe(recorded.agentPresenceByPaneKey)
    expect(store.getState().agentStatusEpoch).toBe(recorded.agentStatusEpoch)
    expect(store.getState().sortEpoch).toBe(recorded.sortEpoch)
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })

  it('drops the exited owner row like a confirmed shell return, keeping its read cutoff', () => {
    const store = createTestStore()
    store.getState().recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: null })
    store.getState().setAgentStatus(paneKey, { state: 'done', prompt: 'task', agentType: 'claude' })
    store.setState({ activityClearedAtByPaneKey: { [paneKey]: 5 } })
    store.getState().recordAgentPresence(paneKey, {
      presence: { ...presence, ended: true },
      receivedAt: 11,
      connectionId: null
    })
    expect(store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().activityClearedAtByPaneKey[paneKey]).toBe(5)
  })

  it("keeps another agent's row when an owner exits", () => {
    const store = createTestStore()
    store.getState().recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: null })
    store
      .getState()
      .setAgentStatus(paneKey, { state: 'working', prompt: 'task', agentType: 'codex' })
    store.getState().recordAgentPresence(paneKey, {
      presence: { ...presence, ended: true },
      receivedAt: 11,
      connectionId: null
    })
    expect(store.getState().agentStatusByPaneKey[paneKey]?.agentType).toBe('codex')
  })

  it('ends an exited owner history on the pane event that proves the shell is back', () => {
    const store = createTestStore()
    store.getState().recordAgentPresence(paneKey, { presence, receivedAt: 10, connectionId: null })
    store.getState().retireEndedAgentPresence(paneKey)
    expect(store.getState().agentPresenceByPaneKey[paneKey]?.presence).toEqual(presence)
    store.getState().recordAgentPresence(paneKey, {
      presence: { ...presence, ended: true },
      receivedAt: 11,
      connectionId: null
    })
    store.getState().retireEndedAgentPresence(paneKey)
    expect(store.getState().agentPresenceByPaneKey[paneKey]).toBeUndefined()
  })
})
