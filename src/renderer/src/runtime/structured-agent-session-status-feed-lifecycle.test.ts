import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))
vi.mock('./runtime-rpc-client', () => ({ runtimeEnvironmentSupportsCapability: vi.fn() }))

import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from './structured-agent-session-status-feed'

type Subscription = {
  emit: (event: AgentSessionStatusEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
}
const subscriptions: Subscription[] = []
const owned: AgentSessionStatusSummary = {
  sessionId: 'running',
  workspaceId: 'workspace',
  agent: 'codex',
  status: 'working',
  latestPrompt: 'work',
  updatedAt: 1,
  hostExecutionOwned: true,
  hostExecutionPhase: 'starting'
}
const done: AgentSessionStatusSummary = {
  ...owned,
  sessionId: 'completed',
  status: 'idle',
  hostExecutionOwned: undefined,
  hostExecutionPhase: undefined,
  runtimePermission: null
}

function subscription(index = 0): Subscription {
  const value = subscriptions[index]
  if (!value) {
    throw new Error('missing subscription')
  }
  return value
}

describe('structured status feed execution authority lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetStructuredAgentSessionStatusFeedsForTests()
    subscriptions.length = 0
    mocks.subscribe.mockReset()
    mocks.subscribe.mockImplementation((_target, emit: Subscription['emit']) => {
      const unsubscribe = vi.fn(() => emit({ type: 'end' }))
      subscriptions.push({ emit, unsubscribe })
      return Promise.resolve({ unsubscribe })
    })
  })

  afterEach(() => {
    resetStructuredAgentSessionStatusFeedsForTests()
    vi.useRealTimers()
  })

  it('revokes on end before reentrant unsubscribe and ignores late frames', async () => {
    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.getNamingActive('running')).toBeNull()
    subscription().emit({
      type: 'snapshot',
      sessions: [owned, done],
      namingActiveSessionIds: ['running']
    })
    subscription().emit({ type: 'snapshot', sessions: [] })
    expect(feed.getNamingActive('running')).toBe(true)
    subscription().emit({ type: 'end' })
    expect(feed.getNamingActive('running')).toBeNull()
    expect(subscription().unsubscribe).toHaveBeenCalledOnce()
    expect(feed.getSnapshot().get('running')).toEqual({
      ...owned,
      hostExecutionOwned: undefined,
      hostExecutionPhase: undefined,
      runtimePermission: null
    })
    expect(feed.getSnapshot().get('completed')).toBe(done)
    subscription().emit({ type: 'status', session: owned })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    subscription(1).emit({ type: 'snapshot', sessions: [] })
    expect(feed.getNamingActive('running')).toBeNull()
    subscription(1).emit({ type: 'snapshot', sessions: [done], namingActiveSessionIds: [] })
    subscription().emit({ type: 'snapshot', sessions: [], namingActiveSessionIds: ['running'] })
    expect(feed.getNamingActive('running')).toBe(false)
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    subscription(1).emit({ type: 'status', session: owned })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBe(true)
  })

  it('drops a Stop the host was ending once contact is lost, owned or not', async () => {
    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    const unowned = { ...owned, sessionId: 'unowned', hostExecutionOwned: undefined }
    subscription().emit({
      type: 'snapshot',
      sessions: [
        { ...owned, stopping: true },
        { ...unowned, stopping: true }
      ]
    })
    expect(feed.getSnapshot().get('running')?.stopping).toBe(true)

    subscription().emit({ type: 'end' })

    expect(feed.getSnapshot().get('running')).not.toHaveProperty('stopping')
    expect(feed.getSnapshot().get('unowned')).not.toHaveProperty('stopping')
    expect(feed.getSnapshot().get('unowned')?.status).toBe('working')
  })

  it('retains history without ownership while stopped and until remount receives fresh evidence', async () => {
    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    const deactivate = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'snapshot', sessions: [owned, done] })
    deactivate()
    expect(vi.getTimerCount()).toBe(0)
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    expect(feed.getSnapshot().get('running')?.updatedAt).toBe(owned.updatedAt)
    expect(feed.getSnapshot().get('completed')).toBe(done)
    feed.activate()
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'status', session: owned })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBeUndefined()
    subscription(1).emit({ type: 'snapshot', sessions: [owned] })
    expect(feed.getSnapshot().get('running')?.hostExecutionOwned).toBe(true)
  })

  it('does not notify or reallocate already unowned historical rows on teardown', async () => {
    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    const deactivate = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    subscription().emit({ type: 'snapshot', sessions: [done] })
    const previous = feed.getSnapshot()
    const listener = vi.fn()
    feed.subscribe(listener)
    deactivate()
    expect(feed.getSnapshot()).toBe(previous)
    expect(listener).not.toHaveBeenCalled()
  })
  it('keeps setup independent of naming/Sleep, folds aliases only within its source and resets empty sources', async () => {
    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    const other = getStructuredAgentSessionStatusFeed({
      kind: 'environment',
      environmentId: 'other'
    })
    const deactivate = feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    const listener = vi.fn()
    feed.subscribe(listener)
    expect(feed.isWorkspaceSetupHeld('repo::C:/Work')).toBeUndefined()
    subscription().emit({
      type: 'snapshot',
      sessions: [],
      setupHeldWorkspaceIds: ['repo::C:\\Work']
    })
    expect(feed.getSessionSleepState('not-yet-restored')).toBeUndefined()
    expect(feed.getNamingActive('running')).toBeNull()
    expect(feed.isWorkspaceSetupHeld('repo::c:/Work')).toBe(true)
    expect(feed.isWorkspaceSetupHeld('other-repo::c:/Work')).toBe(false)
    expect(other.isWorkspaceSetupHeld('repo::c:/Work')).toBeUndefined()
    subscription().emit({
      type: 'snapshot',
      sessions: [],
      namingActiveSessionIds: ['running'],
      setupHeldWorkspaceIds: ['repo::C:/Work']
    })
    expect(feed.getSessionSleepState('not-yet-restored')).toBeUndefined()
    subscription().emit({ type: 'snapshot', sessions: [] })
    expect(feed.getSessionSleepState('not-yet-restored')).toBeNull()
    expect(feed.getNamingActive('running')).toBe(true)
    expect(feed.isWorkspaceSetupHeld('repo::C:/Work')).toBe(true)
    subscription().emit({ type: 'snapshot', sessions: [], setupHeldWorkspaceIds: [] })
    expect(feed.getNamingActive('running')).toBe(true)
    expect(feed.isWorkspaceSetupHeld('repo::C:/Work')).toBe(false)
    subscription().emit({
      type: 'snapshot',
      sessions: [],
      setupHeldWorkspaceIds: ['repo::C:/Work']
    })
    subscription().emit({ type: 'end' })
    expect(feed.isWorkspaceSetupHeld('repo::C:/Work')).toBeUndefined()
    expect(listener).toHaveBeenCalled()
    subscription().emit({
      type: 'snapshot',
      sessions: [],
      setupHeldWorkspaceIds: ['repo::C:/Work']
    })
    expect(feed.isWorkspaceSetupHeld('repo::C:/Work')).toBeUndefined()
    deactivate()
  })

  it('does not copy or enumerate unrelated session summaries for N/10N setup frames', async () => {
    const feed = getStructuredAgentSessionStatusFeed({ kind: 'local' })
    feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    for (const population of [2, 20]) {
      subscription().emit({
        type: 'snapshot',
        sessions: Array.from({ length: population }, (_, index) => ({
          ...done,
          sessionId: `resting-${index}`
        }))
      })
      const previous = feed.getSnapshot()
      const iterate = vi.spyOn(previous, Symbol.iterator)
      for (let index = 0; index < population; index++) {
        subscription().emit({
          type: 'snapshot',
          sessions: [],
          setupHeldWorkspaceIds: index % 2 ? [] : ['workspace']
        })
        expect(feed.getSnapshot()).toBe(previous)
      }
      expect(iterate).not.toHaveBeenCalled()
      iterate.mockRestore()
    }
  })
})
