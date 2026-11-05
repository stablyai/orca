export type NativeChatIdleStopSettings = {
  /** Minutes a chat sits idle before Orca stops its agent process; 0 never stops it. */
  nativeChatIdleStopMinutes?: number
}

export const NATIVE_CHAT_IDLE_STOP_NEVER = 0
export const DEFAULT_NATIVE_CHAT_IDLE_STOP_MINUTES = 30
export const NATIVE_CHAT_IDLE_STOP_MINUTE_CHOICES: readonly number[] = [
  15,
  30,
  60,
  120,
  240,
  480,
  1440,
  NATIVE_CHAT_IDLE_STOP_NEVER
]

/** Saved minutes as given, or the default when absent or unusable; persisted settings are untrusted. */
export function nativeChatIdleStopMinutes(
  settings: { readonly nativeChatIdleStopMinutes?: unknown } | null | undefined
): number {
  const minutes = settings?.nativeChatIdleStopMinutes
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0
    ? minutes
    : DEFAULT_NATIVE_CHAT_IDLE_STOP_MINUTES
}

/** Idle window before Orca stops a chat's agent; null never stops it. */
export function nativeChatIdleStopMs(
  settings: { readonly nativeChatIdleStopMinutes?: unknown } | null | undefined
): number | null {
  const minutes = nativeChatIdleStopMinutes(settings)
  return minutes === NATIVE_CHAT_IDLE_STOP_NEVER ? null : minutes * 60_000
}
