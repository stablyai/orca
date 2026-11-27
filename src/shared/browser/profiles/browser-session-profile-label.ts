/** Display label for a browser profile; each surface passes its own translated "Default". */
export function browserSessionProfileLabel(
  label: string | null | undefined,
  profileId: string | null | undefined,
  defaultLabel: string
): string {
  if (!label?.trim() && profileId && profileId !== 'default') {
    return profileId
  }
  if (profileId === 'default' || !label?.trim() || (profileId == null && label === 'Default')) {
    return defaultLabel
  }
  return label
}
