export type NativeChatUsageLimitAutoContinueSettings = {
  /** On by default: when a chat stops on a usage limit with a known reset time, send it "Continue
   *  where you left off." once the limit resets, unless that chat was told not to. */
  nativeChatAutoContinueAfterUsageLimit?: boolean
  /** One-shot guard for the default-on rollout: a saved false from the old default turns on once;
   *  a later explicit false sticks. */
  nativeChatAutoContinueAfterUsageLimitDefaultedOn?: boolean
}

/** Profiles saved before the default flipped hold the old default as false, which is not an
 *  opt-out; it turns on once, and the stamp keeps every later choice. */
export function normalizeUsageLimitAutoContinueDefaultOn(
  settings: Partial<NativeChatUsageLimitAutoContinueSettings> | undefined
): Required<NativeChatUsageLimitAutoContinueSettings> {
  return {
    nativeChatAutoContinueAfterUsageLimit:
      settings?.nativeChatAutoContinueAfterUsageLimitDefaultedOn === true
        ? settings.nativeChatAutoContinueAfterUsageLimit !== false
        : true,
    nativeChatAutoContinueAfterUsageLimitDefaultedOn: true
  }
}
