import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoConnection } from '../../../../shared/workspace-session-terminal-buffers'
import {
  captureNewlyParkedTerminalTabs,
  resetParkedTerminalTabCaptureEpisodesForTesting,
  scheduleNewlyParkedTerminalTabCapture
} from './parked-terminal-tab-capture-episodes'
import { shutdownBufferCaptures } from './shutdown-buffer-captures'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const REMOTE_REPO: RepoConnection = { id: 'repo', connectionId: 'conn-1', executionHostId: null }
const LOCAL_REPO: RepoConnection = { id: 'repo', connectionId: null, executionHostId: 'local' }
const WORKTREE_ID = 'repo::/repo/worktree'

const storeState: { repos: RepoConnection[] } = { repos: [REMOTE_REPO] }

vi.mock('../../store', () => ({
  useAppStore: { getState: () => storeState }
}))

afterEach(() => {
  shutdownBufferCaptures.clear()
  storeState.repos = [REMOTE_REPO]
  resetParkedTerminalTabCaptureEpisodesForTesting()
})

describe('captureNewlyParkedTerminalTabs', () => {
  it('serializes a newly parked remote tab once per park episode', async () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    const ledger = new Set<string>()

    await captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)
    await captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)

    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith({ includeLocalBuffers: false, yieldBetweenPanes: true })
    expect(ledger).toEqual(new Set(['tab-1']))
  })

  it('re-captures after a reveal, because the replay releases the stored copy', async () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    const ledger = new Set<string>()

    await captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)
    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(), ledger)
    expect(ledger.size).toBe(0)
    await captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)

    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('retries a tab whose pane had no registered capture and captures the rest', async () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    const ledger = new Set<string>()

    await captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1', 'tab-remounting']), ledger)
    expect(ledger).toEqual(new Set(['tab-1']))

    const lateCapture = vi.fn()
    shutdownBufferCaptures.set('tab-remounting', lateCapture)
    await captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1', 'tab-remounting']), ledger)

    expect(capture).toHaveBeenCalledTimes(1)
    expect(lateCapture).toHaveBeenCalledTimes(1)
  })

  it('does not record a tab that was revealed during an in-flight capture', async () => {
    const inFlight = deferred<void>()
    shutdownBufferCaptures.set('tab-1', () => inFlight.promise)
    const ledger = new Set<string>()
    const liveParked = new Set(['tab-1'])

    const pending = captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger, {
      isTabStillParked: (tabId) => liveParked.has(tabId)
    })
    expect(pending).toBeInstanceOf(Promise)

    liveParked.clear()
    inFlight.resolve()
    await pending

    expect(ledger.size).toBe(0)
  })

  it('leaves a local worktree alone — its daemon history is the authoritative copy', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    storeState.repos = [LOCAL_REPO]
    const ledger = new Set<string>()

    const pending = captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)

    expect(pending).toBeUndefined()
    expect(capture).not.toHaveBeenCalled()
    expect(ledger).toEqual(new Set(['tab-1']))
  })
})

describe('scheduleNewlyParkedTerminalTabCapture', () => {
  it('keeps the newer parked set when an older episode settles last', async () => {
    const olderCapture = deferred<void>()
    const newerCapture = deferred<void>()
    shutdownBufferCaptures.set('tab-1', () => olderCapture.promise)
    shutdownBufferCaptures.set('tab-2', () => newerCapture.promise)
    const parkedRef: { current: ReadonlySet<string> } = { current: new Set() }
    const committed: ReadonlySet<string>[] = []
    const setParkedTabIds = (ids: ReadonlySet<string>): void => {
      committed.push(ids)
    }

    scheduleNewlyParkedTerminalTabCapture(
      WORKTREE_ID,
      new Set(['tab-1']),
      parkedRef,
      setParkedTabIds
    )
    scheduleNewlyParkedTerminalTabCapture(
      WORKTREE_ID,
      new Set(['tab-2']),
      parkedRef,
      setParkedTabIds
    )

    newerCapture.resolve()
    await vi.waitFor(() => expect(committed).toEqual([new Set(['tab-2'])]))
    olderCapture.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(committed).toEqual([new Set(['tab-2'])])
    expect(parkedRef.current).toEqual(new Set(['tab-2']))
  })
})
