import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatGitHistoryTimestamp } from './git-history-format'

const commitTime = Date.UTC(2026, 5, 15, 12, 30, 45)

// Assert distinctness rather than literal strings: output follows the runner's locale and time zone.
describe('formatGitHistoryTimestamp', () => {
  it.each([
    ['one second apart', commitTime + 1000],
    ['on the same day in different years', Date.UTC(2025, 5, 15, 12, 30, 45)]
  ])('tells apart commits %s', (_label, otherTime) => {
    expect(formatGitHistoryTimestamp(commitTime)).not.toBe(formatGitHistoryTimestamp(otherTime))
  })
})

// Node reads the OS timezone on Windows and ignores a runtime process.env.TZ change, so the
// stub — and the precondition asserting it took — cannot work there.
describe.skipIf(process.platform === 'win32')('formatGitHistoryTimestamp local-time zone', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('tells apart commits in the hour a DST fall-back repeats', async () => {
    vi.stubEnv('TZ', 'America/New_York')
    // Precondition: the stub took and 2026-11-01 really does replay an hour here.
    expect(new Date(2026, 10, 1, 12).getTimezoneOffset()).toBe(
      new Date(2026, 10, 1, 0).getTimezoneOffset() + 60
    )
    // The formatter binds the time zone when the module loads, so load it under the stub.
    vi.resetModules()
    const { formatGitHistoryTimestamp: formatInNewYork } = await import('./git-history-format')

    // 1:30 AM EDT, then 1:30 AM EST an hour later.
    expect(formatInNewYork(Date.UTC(2026, 10, 1, 5, 30))).not.toBe(
      formatInNewYork(Date.UTC(2026, 10, 1, 6, 30))
    )
  })
})
