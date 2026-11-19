export type PerfNoticeId = 'memory-low' | 'idle-agents' | 'hidden-browser-tabs' | 'disk-almost-full'

type NoticeRecord = { shownCount: number; lastShownAt: number; snoozedUntil: number; off: boolean }
type Ledger = { lastToastAt: number | null; notices: Partial<Record<PerfNoticeId, NoticeRecord>> }

const STORAGE_KEY = 'orca.perfNotices.v1'
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const WEEK = 7 * DAY
const LAUNCH_QUIET_MS = 10 * MINUTE

/** Disk breaks work now: it skips the launch quiet period and the shared daily cap, and snoozes for a day. */
const URGENT: ReadonlySet<PerfNoticeId> = new Set(['disk-almost-full'])

const launchedAt = Date.now()

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
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (isLedger(parsed)) {
      return parsed
    }
  } catch {
    // Unreadable storage starts fresh; worst case one extra toast.
  }
  return { lastToastAt: null, notices: {} }
}

function write(ledger: Ledger): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ledger))
  } catch {
    // Storage can be full or blocked; rate limits then last for this session only.
  }
}

export function canShowPerfNotice(id: PerfNoticeId, now: number): boolean {
  const ledger = read()
  const record = ledger.notices[id]
  if (record?.off || (record && now < record.snoozedUntil)) {
    return false
  }
  if (URGENT.has(id)) {
    return !record || now - record.lastShownAt >= DAY
  }
  if (now - launchedAt < LAUNCH_QUIET_MS) {
    return false
  }
  if (ledger.lastToastAt !== null && now - ledger.lastToastAt < DAY) {
    return false
  }
  return !record || now - record.lastShownAt >= WEEK
}

/** Records the showing and returns how many times this notice has now been shown. */
export function recordPerfNoticeShown(id: PerfNoticeId, now: number): number {
  const ledger = read()
  const previous = ledger.notices[id]
  const shownCount = (previous?.shownCount ?? 0) + 1
  ledger.notices[id] = {
    shownCount,
    lastShownAt: now,
    snoozedUntil: previous?.snoozedUntil ?? 0,
    off: previous?.off ?? false
  }
  if (!URGENT.has(id)) {
    ledger.lastToastAt = now
  }
  write(ledger)
  return shownCount
}

export function snoozePerfNotice(id: PerfNoticeId, now: number): void {
  const ledger = read()
  const record = ledger.notices[id]
  if (record) {
    record.snoozedUntil = now + (URGENT.has(id) ? DAY : WEEK)
    write(ledger)
  }
}

export function turnOffPerfNotice(id: PerfNoticeId): void {
  const ledger = read()
  const record = ledger.notices[id]
  if (record) {
    record.off = true
    write(ledger)
  }
}
