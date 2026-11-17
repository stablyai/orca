/** Splits a Zotz version (1.4.21427) into its Orca base and build, see docs/zotz/UPDATES-SPEC.md §3. */
export function describeZotzVersion(version: string): { orcaBase: string; build: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) {
    return null
  }
  const patch = Number(match[3])
  // Releases have a five-digit patch (Orca 1.4.214 → 214xx); dev builds keep Orca's own version.
  if (patch < 10_000 || patch % 100 === 0) {
    return null
  }
  return { orcaBase: `${match[1]}.${match[2]}.${Math.floor(patch / 100)}`, build: patch % 100 }
}
