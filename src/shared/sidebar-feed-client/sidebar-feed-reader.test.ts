import { expect, it } from 'vitest'
import {
  SidebarFeedReader,
  type SidebarFeedReaderRead,
  type SidebarFeedReadOutcome
} from './sidebar-feed-reader'

it('does not let a superseded unavailable reply disable an installed feed', async () => {
  const pending: ((outcome: SidebarFeedReadOutcome) => void)[] = []
  const reads: SidebarFeedReaderRead[] = []
  const reader = new SidebarFeedReader(
    () => new Promise((resolve) => pending.push(resolve)),
    { retryDelayMs: () => null },
    (read) => reads.push(read)
  )
  try {
    reader.refresh()
    reader.refresh()
    pending[1]({
      kind: 'answered',
      reply: {
        generation: 'host',
        revision: 1,
        schemaVersion: 1,
        semanticsVersion: 3,
        kind: 'snapshot',
        from: null,
        domains: {},
        next: null
      }
    })
    await Promise.resolve()
    pending[0]({ kind: 'unavailable' })
    await Promise.resolve()
    expect(reads.at(-1)?.unavailable).toBe(false)
    expect(reads.at(-1)?.snapshot?.installed.revision).toBe(1)
  } finally {
    reader.dispose()
  }
})
