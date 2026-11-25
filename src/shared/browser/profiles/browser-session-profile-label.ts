/** Display label for a browser profile; each surface passes its own translated "Default". */
export function browserSessionProfileLabel(
  label: string | null | undefined,
  profileId: string | null | undefined,
  defaultLabel: string
): string {
  if (!label?.trim() && profileId && profileId !== 'default') {
    return profileId
  }
  // A renamed default keeps its own label; the built-in name still follows the UI language.
  if (!label?.trim() || ((profileId === 'default' || profileId == null) && label === 'Default')) {
    return defaultLabel
  }
  return label
}
