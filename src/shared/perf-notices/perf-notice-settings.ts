export const PERF_NOTICE_IDS = ['disk-almost-full', 'hidden-browser-tabs'] as const
export type PerfNoticeId = (typeof PERF_NOTICE_IDS)[number]

export type PerfNoticeGlobalSettings = {
  /** Notices turned off with Don't show again; Settings > Notifications turns each back on. */
  perfNoticesOff?: PerfNoticeId[]
}

export function isPerfNoticeOff(
  settings: PerfNoticeGlobalSettings | null | undefined,
  id: PerfNoticeId
): boolean {
  return Array.isArray(settings?.perfNoticesOff) && settings.perfNoticesOff.includes(id)
}

/** The off list with one notice turned on or off, keeping only known ids. */
export function withPerfNoticeOff(
  settings: PerfNoticeGlobalSettings | null | undefined,
  id: PerfNoticeId,
  off: boolean
): PerfNoticeId[] {
  const current = PERF_NOTICE_IDS.filter((known) => isPerfNoticeOff(settings, known))
  return off ? [...new Set([...current, id])] : current.filter((known) => known !== id)
}
