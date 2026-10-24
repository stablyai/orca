import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatGitHistoryCommitTimeColumn, formatGitHistoryTimestamp } from './git-history-format'

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

// The list column is opt-in and renders nothing at all when it has nothing trustworthy to show,
// so a malformed timestamp must not leave an empty cell — or an "Invalid Date" one — behind.
describe('formatGitHistoryCommitTimeColumn', () => {
  const now = Date.UTC(2026, 5, 15, 13, 0, 0)

  it('renders no cell while the column is hidden', () => {
    expect(formatGitHistoryCommitTimeColumn(commitTime, 'hidden', now)).toBeNull()
  })

  it.each([Number.NaN, Number.MAX_VALUE])(
    'renders no cell for malformed timestamp %s',
    (malformedTimestamp) => {
      expect(formatGitHistoryCommitTimeColumn(malformedTimestamp, 'absolute', now)).toBeNull()
      expect(formatGitHistoryCommitTimeColumn(malformedTimestamp, 'relative', now)).toBeNull()
    }
  )

  it('renders no cell for a commit that carries no timestamp', () => {
    expect(formatGitHistoryCommitTimeColumn(undefined, 'absolute', now)).toBeNull()
    expect(formatGitHistoryCommitTimeColumn(undefined, 'relative', now)).toBeNull()
  })

  // Why: the request was to tell commits apart by when they were made, so the column has to
  // separate commits that a date-only column renders identically.
  it.each(['absolute', 'relative'] as const)(
    'tells apart commits a minute apart in the %s column',
    (format) => {
      expect(formatGitHistoryCommitTimeColumn(commitTime, format, now)?.label).not.toBe(
        formatGitHistoryCommitTimeColumn(commitTime + 60_000, format, now)?.label
      )
    }
  )

  it('tells apart same-day commits a year apart in the absolute column', () => {
    expect(formatGitHistoryCommitTimeColumn(commitTime, 'absolute', now)?.label).not.toBe(
      formatGitHistoryCommitTimeColumn(Date.UTC(2025, 5, 15, 12, 30, 45), 'absolute', now)?.label
    )
  })

  // Why: today needs no date, and the width that frees is what keeps a run of same-day commits
  // readable. Local-time construction keeps the assertion true in any time zone.
  it('drops the date for today, keeps it for an earlier day, and marks only today compact', () => {
    const localNow = new Date(2026, 5, 15, 13, 0, 0).getTime()
    const today = formatGitHistoryCommitTimeColumn(
      new Date(2026, 5, 15, 9, 30, 45).getTime(),
      'absolute',
      localNow
    )
    const earlierDay = formatGitHistoryCommitTimeColumn(
      new Date(2026, 5, 14, 9, 30, 45).getTime(),
      'absolute',
      localNow
    )

    expect(today?.compact).toBe(true)
    expect(earlierDay?.compact).toBe(false)
    expect((today?.label ?? '').length).toBeLessThan((earlierDay?.label ?? '').length)
  })
})
