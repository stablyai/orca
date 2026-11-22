import type { PerfNoticeId } from '../../../../shared/perf-notices/perf-notice-settings'

/** Rate limits only; Don't show again lives in settings so it follows the user across windows. */
type NoticeRecord = { lastShownAt: number; snoozedUntil: number }
type Ledger = { lastToastAt: number | null; notices: Partial<Record<PerfNoticeId, NoticeRecord>> }

const STORAGE_KEY = 'orca.perfNotices.v1'
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const WEEK = 7 * DAY
const LAUNCH_QUIET_MS = 10 * MINUTE

/** Disk breaks work now: it skips the launch quiet period, and repeats and snoozes by the day. */
const URGENT: ReadonlySet<PerfNoticeId> = new Set(['disk-almost-full'])

const launchedAt = Date.now()
// Why: if storage fails, this copy keeps snoozes and caps for the rest of the session.
let sessionLedger: Ledger = { lastToastAt: null, notices: {} }
// Why: after a failed write, storage holds an older ledger that must not overwrite newer state.
let storageFailed = false

function isLedger(value: unknown): value is Ledger {
  return (
    typeof value === 'object' &&
    value !== null &&
    'notices' in value &&
    typeof value.notices === 'object' &&
    value.notices !== null &&
    'lastToastAt' in value &&
    (value.lastToastAt === null || typeof value.lastToastAt === 'number')
  )
}

function read(): Ledger {
  if (storageFailed) {
    return sessionLedger
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (isLedger(parsed)) {
      sessionLedger = parsed
    }
  } catch {
    // Unreadable storage keeps the session copy.
  }
  return sessionLedger
}

function write(ledger: Ledger): void {
  sessionLedger = ledger
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger))
    // Why: storage now holds this window's newest state, so other windows' writes count again.
    storageFailed = false
  } catch {
    storageFailed = true
  }
}

export function canShowPerfNotice(id: PerfNoticeId, now: number): boolean {
  const ledger = read()
  const record = ledger.notices[id]
  if (record && now < record.snoozedUntil) {
    return false
  }
  if (!URGENT.has(id) && now - launchedAt < LAUNCH_QUIET_MS) {
    return false
  }
  if (ledger.lastToastAt !== null && now - ledger.lastToastAt < DAY) {
    return false
  }
  return !record || now - record.lastShownAt >= (URGENT.has(id) ? DAY : WEEK)
}

export function recordPerfNoticeShown(id: PerfNoticeId, now: number): void {
  const ledger = read()
  write({
    lastToastAt: now,
    notices: {
      ...ledger.notices,
      [id]: { lastShownAt: now, snoozedUntil: ledger.notices[id]?.snoozedUntil ?? 0 }
    }
  })
}

export function snoozePerfNotice(id: PerfNoticeId, now: number): void {
  const ledger = read()
  const record = ledger.notices[id]
  if (record) {
    write({
      ...ledger,
      notices: {
        ...ledger.notices,
        [id]: { ...record, snoozedUntil: now + (URGENT.has(id) ? DAY : WEEK) }
      }
    })
  }
}
