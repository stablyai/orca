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

// Windows ignores runtime TZ changes, so the stub and its precondition cannot work there.
describe.skipIf(process.platform === 'win32')('formatGitHistoryTimestamp local-time zone', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('tells apart commits in the hour a DST fall-back repeats', async () => {
    vi.stubEnv('TZ', 'America/New_York')
    expect(new Date(2026, 10, 1, 12).getTimezoneOffset()).toBe(
      new Date(2026, 10, 1, 0).getTimezoneOffset() + 60
    )
    // Reload under the stub because the formatter captures its zone on import.
    vi.resetModules()
    const { formatGitHistoryTimestamp: formatInNewYork } = await import('./git-history-format')

    // 1:30 AM EDT, then 1:30 AM EST an hour later.
    expect(formatInNewYork(Date.UTC(2026, 10, 1, 5, 30))).not.toBe(
      formatInNewYork(Date.UTC(2026, 10, 1, 6, 30))
    )
  })
})
