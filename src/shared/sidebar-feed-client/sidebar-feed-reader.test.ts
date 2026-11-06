import { describe, expect, it, vi } from 'vitest'
import { SidebarInputsFeed } from '../../main/runtime/sidebar-inputs/sidebar-inputs-feed'
import { testDomain } from '../../main/runtime/sidebar-inputs/sidebar-inputs-feed.test-fixture'
import type {
  SidebarInputsChangedEvent,
  SidebarInputsReadParams
} from '../sidebar-list/sidebar-inputs-feed-contract'
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

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('SidebarFeedReader', () => {
  it('installs the host’s snapshot, then follows each notice to the newer revision', async () => {
    const host = hostWithFeed()
    host.reader.refresh()
    await settle()
    const first = host.installed()
    expect(first.domains.get('workspaces')?.get('a')).toEqual({ id: 'a' })

    host.workspaces.set('b', { id: 'b' })
    await vi.waitFor(() => expect(host.notices.at(-1)?.revision).toBeGreaterThan(first.revision))
    const notice = host.notices.at(-1)!
    host.reader.changed(notice)
    await settle()
    const next = host.installed()
    expect(next.revision).toBeGreaterThan(first.revision)
    expect(next.domains.get('workspaces')?.get('b')).toEqual({ id: 'b' })

    // A duplicate or late notice is already covered: no read goes out.
    const sent = host.transport.mock.calls.length
    host.reader.changed(notice)
    await settle()
    expect(host.transport.mock.calls.length).toBe(sent)
  })

  it('names the read each settled install answers, keeping unchanged domains', async () => {
    const host = hostWithFeed()
    const first = host.reader.refresh()
    await settle()
    expect(host.reads.at(-1)?.settledBy).toBe(first)
    const domains = host.reads.at(-1)!.snapshot!.domains
    const second = host.reader.refresh()
    await settle()
    expect(second).toBeGreaterThan(first)
    expect(host.reads.at(-1)?.settledBy).toBe(second)
    expect(host.reads.at(-1)!.snapshot!.domains.workspaces).toBe(domains.workspaces)
  })

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
      expect(transport).toHaveBeenCalledOnce()
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

  it('stops retrying a host that keeps failing, and when the screen lets go', async () => {
    vi.useFakeTimers()
    try {
      const host = hostWithFeed()
      host.transport.mockRejectedValue(new Error('Request timed out: sidebarInputs.read'))
      host.reader.refresh()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      const attempts = host.transport.mock.calls.length
      expect(attempts).toBeGreaterThan(1)
      expect(attempts).toBeLessThan(10)

      // A fresh trigger gets a fresh budget, which disposal cancels.
      host.reader.refresh()
      await vi.advanceTimersByTimeAsync(0)
      host.reader.dispose()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(host.transport.mock.calls.length).toBe(attempts + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays bounded when a batch’s first page answers but a later page keeps failing', async () => {
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
      expect(host.transport.mock.calls.length).toBeLessThan(20)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a reply that lands after the screen let go of its host', async () => {
    const host = hostWithFeed()
    host.reader.refresh()
    host.reader.dispose()
    await settle()
    expect(host.reads).toEqual([])
  })
})
