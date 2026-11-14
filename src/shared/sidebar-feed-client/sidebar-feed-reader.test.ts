import { describe, expect, it, vi } from 'vitest'
import { SidebarInputsFeed } from '../../main/runtime/sidebar-inputs/feed/sidebar-inputs-feed'
import { testDomain } from '../../main/runtime/sidebar-inputs/feed/testing/sidebar-inputs-feed.test-fixture'
import type {
  SidebarInputsChangedEvent,
  SidebarInputsReadParams
} from '../sidebar-list/feed/sidebar-inputs-feed-contract'
import {
  SidebarFeedReader,
  type SidebarFeedReadOutcome,
  type SidebarFeedReaderRead
} from './sidebar-feed-reader'

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000]
const backoff = (failures: number): number | null => BACKOFF_MS[failures] ?? null

/** The host's real feed behind a transport that answers every read from it. */
function hostWithFeed(retryDelayMs = backoff) {
  const notices: SidebarInputsChangedEvent[] = []
  const workspaces = testDomain('workspaces', { a: { id: 'a' } })
  const feed = new SidebarInputsFeed(
    () => [workspaces.domain],
    (event) => notices.push(event)
  )
  feed.acquire('phone')
  const transport = vi.fn(
    async (params: SidebarInputsReadParams): Promise<SidebarFeedReadOutcome> => ({
      kind: 'answered',
      reply: await feed.read(params)
    })
  )
  const reads: SidebarFeedReaderRead[] = []
  const reader = new SidebarFeedReader(transport, { retryDelayMs }, (read) => reads.push(read))
  const installed = () => reads.at(-1)!.snapshot!.installed
  return { feed, workspaces, notices, transport, reader, reads, installed }
}

describe('SidebarFeedReader', () => {
  it('reads a host without the feed as unavailable, and stops retrying it', async () => {
    vi.useFakeTimers()
    try {
      const reads: SidebarFeedReaderRead[] = []
      const transport = vi.fn(async (): Promise<SidebarFeedReadOutcome> => ({
        kind: 'unavailable'
      }))
      new SidebarFeedReader(transport, { retryDelayMs: backoff }, (read) =>
        reads.push(read)
      ).refresh()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(reads).toEqual([{ snapshot: null, unavailable: true, settledBy: null }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('catches up on its own when a read times out with the connection still up', async () => {
    vi.useFakeTimers()
    try {
      const host = hostWithFeed()
      host.reader.refresh()
      await vi.advanceTimersByTimeAsync(0)
      const first = host.installed()

      let timeOut: (error: Error) => void = () => {}
      host.transport.mockImplementationOnce(
        () => new Promise<SidebarFeedReadOutcome>((_resolve, reject) => (timeOut = reject))
      )
      host.workspaces.set('b', { id: 'b' })
      await vi.advanceTimersByTimeAsync(1_000)
      host.reader.changed(host.notices.at(-1)!)
      // A newer notice lands while that read waits; nothing else will repeat it.
      host.workspaces.set('c', { id: 'c' })
      await vi.advanceTimersByTimeAsync(1_000)
      host.reader.changed(host.notices.at(-1)!)
      timeOut(new Error('Request timed out: sidebarInputs.read'))

      await vi.advanceTimersByTimeAsync(30_000)
      const caughtUp = host.installed()
      expect(caughtUp.revision).toBeGreaterThan(first.revision)
      expect(caughtUp.domains.get('workspaces')?.get('c')).toEqual({ id: 'c' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never installs a partial batch when its later pages keep failing', async () => {
    vi.useFakeTimers()
    try {
      const host = hostWithFeed()
      const answer = host.transport.getMockImplementation()!
      host.transport.mockImplementation(async (params) => {
        const outcome = await answer(params)
        if (params.pageToken !== undefined) {
          throw new Error('Request timed out: sidebarInputs.read')
        }
        // Every first page says more follows, so no batch ever installs.
        return outcome.kind === 'answered'
          ? { kind: 'answered', reply: { ...outcome.reply, next: 'p#1' } }
          : outcome
      })
      host.reader.refresh()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(host.reads).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
