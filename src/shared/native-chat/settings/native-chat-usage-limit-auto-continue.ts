import type { GlobalSettings } from '../../settings/global-settings-types'

type UsageLimitAutoContinueSettings = Pick<
  GlobalSettings,
  'nativeChatAutoContinueAfterUsageLimit' | 'nativeChatAutoContinueAfterUsageLimitDefaultedOn'
>

/** Profiles saved before the default flipped hold the old default as false, which is not an
 *  opt-out; it turns on once, and the stamp keeps every later choice. */
export function normalizeUsageLimitAutoContinueDefaultOn(
  settings: Partial<UsageLimitAutoContinueSettings> | undefined
): Required<UsageLimitAutoContinueSettings> {
  return {
    nativeChatAutoContinueAfterUsageLimit:
      settings?.nativeChatAutoContinueAfterUsageLimitDefaultedOn === true
        ? settings.nativeChatAutoContinueAfterUsageLimit !== false
        : true,
    nativeChatAutoContinueAfterUsageLimitDefaultedOn: true
  }
}
