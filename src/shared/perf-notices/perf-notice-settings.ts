export const PERF_NOTICE_IDS = ['disk-almost-full', 'hidden-browser-tabs'] as const
export type PerfNoticeId = (typeof PERF_NOTICE_IDS)[number]

export type PerfNoticeGlobalSettings = {
  /** Notices turned off with Don't show again; Settings > Notifications turns each back on.
   *  Ids this build doesn't know are kept, so a newer build's opt-outs survive a downgrade. */
  perfNoticesOff?: string[]
}

export function isPerfNoticeOff(
  settings: PerfNoticeGlobalSettings | null | undefined,
  id: PerfNoticeId
): boolean {
  return Array.isArray(settings?.perfNoticesOff) && settings.perfNoticesOff.includes(id)
}

/** The off list with one notice turned on or off. */
export function withPerfNoticeOff(
  settings: PerfNoticeGlobalSettings | null | undefined,
  id: PerfNoticeId,
  off: boolean
): string[] {
  const saved = settings?.perfNoticesOff
  const current = Array.isArray(saved)
    ? saved.filter((entry): entry is string => typeof entry === 'string')
    : []
  return off ? [...new Set([...current, id])] : current.filter((entry) => entry !== id)
}
