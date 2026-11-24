/** One named thing a list shows: a plugin, or a theme or other content a plugin contributes. */
export type PluginNameCandidate = {
  key: string
  name: string
  /** Orca-derived publisher (the repository owner); null when there is none to show. */
  publisher: string | null
  official: boolean
}

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase()
}

/**
 * Keys of the items that should show their publisher after their name: those sharing a name with
 * another item in the same list, except official ones, which keep the plain name.
 */
export function pluginNameClashKeys(items: readonly PluginNameCandidate[]): Set<string> {
  const keysByName = new Map<string, Set<string>>()
  for (const item of items) {
    const name = nameKey(item.name)
    keysByName.set(name, (keysByName.get(name) ?? new Set()).add(item.key))
  }
  const clashing = new Set<string>()
  for (const item of items) {
    if (!item.official && item.publisher && (keysByName.get(nameKey(item.name))?.size ?? 0) > 1) {
      clashing.add(item.key)
    }
  }
  return clashing
}
