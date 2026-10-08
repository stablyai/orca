/**
 * Whether this profile had experimental native chat on when Chat UI left Experimental.
 * Main captures it once from the saved profile and never re-derives it from the live toggle,
 * because after graduation anyone can turn Chat UI on.
 */
export type NativeChatGraduationCohort = 'experimental-opt-in' | 'other'

export function isNativeChatGraduationCohort(value: unknown): value is NativeChatGraduationCohort {
  return value === 'experimental-opt-in' || value === 'other'
}

/** Fails closed: a missing, malformed, or projected-away marker is never the opt-in cohort. */
export function isNativeChatGraduationOptIn(
  settings: { nativeChatGraduationCohort?: unknown } | null | undefined
): boolean {
  return settings?.nativeChatGraduationCohort === 'experimental-opt-in'
}

/** Classifies a profile from its saved settings as they were before this release touched them. */
export function classifyNativeChatGraduationCohort(args: {
  fileExistedOnLoad: boolean
  savedExperimentalNativeChat: unknown
}): NativeChatGraduationCohort {
  return args.fileExistedOnLoad && args.savedExperimentalNativeChat === true
    ? 'experimental-opt-in'
    : 'other'
}
