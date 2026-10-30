import type { GlobalSettings } from './global-settings-types'

export type NativeChatFollowUpBehavior = 'queue' | 'steer'

/** What Enter does with a message while the agent works; missing or unknown reads as Steer. */
export function nativeChatFollowUpBehavior(
  settings: { readonly nativeChatFollowUpBehavior?: unknown } | null | undefined
): NativeChatFollowUpBehavior {
  return settings?.nativeChatFollowUpBehavior === 'queue' ? 'queue' : 'steer'
}

export function nativeChatFollowUpBehaviorUpdate(
  value: NativeChatFollowUpBehavior
): Pick<GlobalSettings, 'nativeChatFollowUpBehavior'> {
  return { nativeChatFollowUpBehavior: value }
}
