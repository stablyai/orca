// Gate desktop presence reports on host capability; older hosts return method-not-found, and older silent desktops read as away.
export const NOTIFICATIONS_DESKTOP_PRESENCE_RUNTIME_CAPABILITY =
  'notifications.desktop-presence.v1' as const

/** A desktop re-reports this often while connected, so the host can expire a silent one. */
export const DESKTOP_PRESENCE_REPORT_INTERVAL_MS = 30_000

/** A report older than this no longer counts: three missed reports read as away. */
export const DESKTOP_PRESENCE_TTL_MS = 3 * DESKTOP_PRESENCE_REPORT_INTERVAL_MS
