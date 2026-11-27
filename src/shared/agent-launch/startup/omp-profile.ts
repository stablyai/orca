/** OMP's profile name rule: undefined selects the default profile, null is a name OMP rejects. */
export function normalizedOmpProfile(value: string | undefined): string | undefined | null {
  const profile = value?.trim()
  if (!profile || profile === 'default') {
    return undefined
  }
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) &&
    !profile.endsWith('.') &&
    !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(profile)
    ? profile
    : null
}

// <config home>/profiles/<name>/agent/sessions or $XDG_DATA_HOME/omp/profiles/<name>/sessions.
const OMP_PROFILE_SESSIONS_DIR =
  /[\\/]profiles[\\/]([^\\/]+)[\\/]agent[\\/]sessions[\\/]|[\\/]omp[\\/]profiles[\\/]([^\\/]+)[\\/]sessions[\\/]/

/** `--profile <name>` for a transcript in a named profile's store: OMP takes the profile only from flag or env, never from the resumed path. */
export function ompTranscriptProfileArgs(transcriptPath: string | null | undefined): string[] {
  const match = transcriptPath?.match(OMP_PROFILE_SESSIONS_DIR)
  const profile = normalizedOmpProfile(match?.[1] ?? match?.[2])
  return profile ? ['--profile', profile] : []
}
