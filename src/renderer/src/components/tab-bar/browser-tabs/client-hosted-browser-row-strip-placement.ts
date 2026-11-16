/** Assign paired-client rows to the first group so they appear once and never follow focus between strips. */
export function resolveClientHostedBrowserRowStripGroupId(
  groups: readonly { id: string }[]
): string | null {
  return groups[0]?.id ?? null
}
