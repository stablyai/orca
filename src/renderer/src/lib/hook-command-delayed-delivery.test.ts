import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  queueHookCommandsForFirstWorktreeTab,
  resetHookCommandDelayedDeliveryForTests
} from './hook-command-delayed-delivery'

type AppState = ReturnType<typeof useAppStore.getState>

const initialTabsByWorktree = useAppStore.getState().tabsByWorktree
const initialGetKnownWorktreeById = useAppStore.getState().getKnownWorktreeById

function setStorePartial(partial: Record<string, unknown>): void {
  useAppStore.setState(partial as Partial<AppState>)
}

function markWorktreeKnown(worktreeId: string): void {
  setStorePartial({
    getKnownWorktreeById: ((id: string) =>
      id === worktreeId ? { id } : undefined) as unknown as AppState['getKnownWorktreeById']
  })
}

afterEach(() => {
  resetHookCommandDelayedDeliveryForTests()
  setStorePartial({
    tabsByWorktree: initialTabsByWorktree,
    getKnownWorktreeById: initialGetKnownWorktreeById
  })
})

describe('queueHookCommandsForFirstWorktreeTab', () => {
  it('holds the delivery until the first worktree tab lands, then delivers exactly once', () => {
    markWorktreeKnown('wt-1')
    setStorePartial({ tabsByWorktree: {} })
    const deliver = vi.fn()

    queueHookCommandsForFirstWorktreeTab({ worktreeId: 'wt-1', deliver })
    expect(deliver).not.toHaveBeenCalled()

    setStorePartial({ tabsByWorktree: { 'wt-1': [{ id: 'mirror-tab-1' }] } })

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith(expect.anything(), 'mirror-tab-1')

    // Later tab churn must not re-deliver the consumed entry.
    setStorePartial({ tabsByWorktree: { 'wt-1': [{ id: 'mirror-tab-1' }, { id: 'tab-2' }] } })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('delivers immediately when the worktree already has a tab at queue time', () => {
    markWorktreeKnown('wt-1')
    setStorePartial({ tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] } })
    const deliver = vi.fn()

    queueHookCommandsForFirstWorktreeTab({ worktreeId: 'wt-1', deliver })

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith(expect.anything(), 'tab-1')
  })

  it('keeps every delivery queued for the same worktree', () => {
    // Setup/issue commands and agent seeds must coexist while awaiting the same mirrored terminal.
    markWorktreeKnown('wt-1')
    setStorePartial({ tabsByWorktree: {} })
    const deliverFirst = vi.fn()
    const deliverSecond = vi.fn()

    queueHookCommandsForFirstWorktreeTab({ worktreeId: 'wt-1', deliver: deliverFirst })
    queueHookCommandsForFirstWorktreeTab({ worktreeId: 'wt-1', deliver: deliverSecond })

    setStorePartial({ tabsByWorktree: { 'wt-1': [{ id: 'mirror-tab-1' }] } })

    expect(deliverFirst).toHaveBeenCalledTimes(1)
    expect(deliverSecond).toHaveBeenCalledTimes(1)
    expect(deliverSecond).toHaveBeenCalledWith(expect.anything(), 'mirror-tab-1')
  })

  it('drops the pending delivery when the worktree is no longer known', () => {
    setStorePartial({
      tabsByWorktree: {},
      getKnownWorktreeById: (() => undefined) as unknown as AppState['getKnownWorktreeById']
    })
    const deliver = vi.fn()

    queueHookCommandsForFirstWorktreeTab({ worktreeId: 'wt-gone', deliver })

    // Removal before first mirror must discard pending commands even if the tab ID later reappears.
    markWorktreeKnown('wt-gone')
    setStorePartial({ tabsByWorktree: { 'wt-gone': [{ id: 'tab-1' }] } })
    expect(deliver).not.toHaveBeenCalled()
  })
})
