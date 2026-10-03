import { describe, expect, it } from 'vitest'
import { createProcessTableSnapshotReader } from './process-table-snapshot-reader'

function slowReader() {
  let clock = 0
  const runs: { startedAt: number; finish: (value: string) => void }[] = []
  const reader = createProcessTableSnapshotReader<string>({
    now: () => clock,
    runPs: () =>
      new Promise<string>((resolve) => {
        runs.push({ startedAt: clock, finish: resolve })
      })
  })
  return {
    reader,
    runs,
    tick: (ms: number) => {
      clock += ms
    }
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a process table read that answers evidence', () => {
  it('never takes a table that began before the evidence, even one still running', async () => {
    const { reader, runs, tick } = slowReader()
    void reader.getSnapshot()
    tick(5_000)
    // The agent starts here; a capture one second later must not reuse the older `ps`.
    const evidenceAt = 5_000
    tick(1_000)
    const answered = reader.getSnapshotSince(evidenceAt)
    await settle()
    expect(runs).toHaveLength(1)
    tick(9_000)
    runs[0].finish('table without the agent')
    await settle()
    expect(runs).toHaveLength(2)
    expect(runs[1].startedAt).toBeGreaterThanOrEqual(evidenceAt)
    runs[1].finish('table with the agent')
    await expect(answered).resolves.toBe('table with the agent')
  })

  it('lets waiters for different evidence share the next table instead of piling up', async () => {
    const { reader, runs, tick } = slowReader()
    void reader.getSnapshot()
    tick(100)
    const first = reader.getSnapshotSince(100)
    tick(100)
    const second = reader.getSnapshotSince(200)
    tick(10_000)
    runs[0].finish('old')
    await settle()
    expect(runs).toHaveLength(2)
    runs[1].finish('new')
    await expect(Promise.all([first, second])).resolves.toEqual(['new', 'new'])
  })

  it('joins or reuses a table that began after the evidence without another ps', async () => {
    const { reader, runs, tick } = slowReader()
    tick(100)
    const running = reader.getSnapshot()
    const joined = reader.getSnapshotSince(50)
    expect(runs).toHaveLength(1)
    runs[0].finish('fresh')
    await expect(joined).resolves.toBe('fresh')
    await running
    tick(60_000)
    await expect(reader.getSnapshotSince(100)).resolves.toBe('fresh')
    expect(runs).toHaveLength(1)
  })

  it('starts no new table for a waiter abandoned while it waited', async () => {
    const { reader, runs, tick } = slowReader()
    void reader.getSnapshot()
    tick(100)
    let wanted = true
    const abandoned = reader.getSnapshotSince(100, () => wanted)
    wanted = false
    tick(10_000)
    runs[0].finish('old')
    await expect(abandoned).rejects.toThrow('abandoned')
    expect(runs).toHaveLength(1)
  })
})
