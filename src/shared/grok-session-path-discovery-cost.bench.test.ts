import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clearGrokSessionPathLookupCacheForTests,
  findGrokChatHistoryBySessionId,
  GROK_SESSION_GROUP_SCAN_MAX_ENTRIES
} from './grok-session-paths'

const describePerf = process.env.ORCA_GROK_PATH_PERF_BENCH === '1' ? describe : describe.skip
const ROUNDS = 5

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

describePerf('Grok session path discovery cost', () => {
  let root = ''
  let sessionsDir = ''

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-grok-path-cost-'))
    sessionsDir = join(root, 'sessions')
    await mkdir(sessionsDir)
    await Promise.all(
      Array.from({ length: GROK_SESSION_GROUP_SCAN_MAX_ENTRIES }, (_unused, index) =>
        mkdir(join(sessionsDir, `group-${index}`))
      )
    )
  })

  afterAll(async () => {
    clearGrokSessionPathLookupCacheForTests()
    await rm(root, { recursive: true, force: true })
  })

  it('measures one bounded missing-session scan through real filesystem IO', async () => {
    const durations: number[] = []
    for (let round = 0; round < ROUNDS; round++) {
      clearGrokSessionPathLookupCacheForTests()
      const startedAt = performance.now()
      const result = await findGrokChatHistoryBySessionId(sessionsDir, `missing-session-${round}`)
      durations.push(performance.now() - startedAt)
      expect(result).toBeNull()
    }
    console.log(
      `bounded Grok discovery median: ${median(durations).toFixed(2)} ms ` +
        `(${GROK_SESSION_GROUP_SCAN_MAX_ENTRIES} groups)`
    )
  })
})
