export function branchRefLabel(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '')
}

/** Prefer the server's selector; otherwise the probe proves local main/master or a remote HEAD/fallback. */
export function probedDefaultBranchRef(
  ref: string | null,
  results: readonly string[] = []
): string | null {
  if (!ref || ref.startsWith('refs/') || results.includes(ref)) {
    return ref
  }
  return ref === 'main' || ref === 'master' ? `refs/heads/${ref}` : `refs/remotes/${ref}`
}

export function branchRefLabels(refs: readonly string[]): ReadonlyMap<string, string> {
  const identities = new Map<string, Set<string>>()
  for (const ref of refs) {
    if (!/^refs\/(heads|remotes)\//.test(ref)) {
      continue
    }
    const label = branchRefLabel(ref)
    const existing = identities.get(label) ?? new Set<string>()
    existing.add(ref)
    identities.set(label, existing)
  }
  return new Map(
    refs.map((ref) => {
      const label = branchRefLabel(ref)
      return [ref, (identities.get(label)?.size ?? 0) > 1 ? ref : label]
    })
  )
}
