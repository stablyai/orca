export type NativeChatFollowUpBehavior = 'queue' | 'steer'

/** Only explicit OFF disables queueing on capable hosts. */
export function nativeChatQueueFollowUps(
  settings: { readonly nativeChatQueueFollowUps?: unknown } | null | undefined
): boolean {
  return settings?.nativeChatQueueFollowUps !== false
}
