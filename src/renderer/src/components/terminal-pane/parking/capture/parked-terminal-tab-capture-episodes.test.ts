import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoConnection } from '../../../../../../shared/workspace-session/workspace-session-terminal-buffers'
import {
  captureNewlyParkedTerminalTabs,
  resetParkedTerminalTabCaptureEpisodesForTesting,
  scheduleNewlyParkedTerminalTabCapture
} from './parked-terminal-tab-capture-episodes'
import { shutdownBufferCaptures } from '../../snapshots/shutdown-buffer-captures'

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

vi.mock('../../../../store/index', () => ({
  useAppStore: { getState: () => storeState }
}))

afterEach(() => {
  shutdownBufferCaptures.clear()
  storeState.repos = [REMOTE_REPO]
  resetParkedTerminalTabCaptureEpisodesForTesting()
})

describe('captureNewlyParkedTerminalTabs', () => {
  it('serializes a newly parked remote tab once and yields between panes', async () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    const ledger = new Set<string>()

    await captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)
    await captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)

    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith({
      includeLocalBuffers: false,
      localOnly: true,
      yieldBetweenPanes: true
    })
    expect(ledger).toEqual(new Set(['tab-1']))
  })

  it('leaves a local worktree alone so its daemon history stays authoritative', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)
    storeState.repos = [LOCAL_REPO]
    const ledger = new Set<string>()

    captureNewlyParkedTerminalTabs(WORKTREE_ID, new Set(['tab-1']), ledger)

    expect(capture).not.toHaveBeenCalled()
    expect(ledger).toEqual(new Set(['tab-1']))
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
