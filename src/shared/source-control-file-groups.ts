import {
  isOrcaYamlFieldWithinLimit,
  MAX_ORCA_YAML_COLLECTION_ENTRIES
} from './orca-yaml-file-limit'

export type SourceControlFileGroup = {
  name: string
  patterns: string[]
}

/** Keeps group names unique and bounds repo-authored patterns without changing gitignore escapes. */
export function normalizeSourceControlFileGroups(value: unknown): SourceControlFileGroup[] {
  if (!Array.isArray(value) || value.length > MAX_ORCA_YAML_COLLECTION_ENTRIES) {
    return []
  }
  const groups: SourceControlFileGroup[] = []
  const names = new Set<string>()
  for (const candidate of value) {
    const entry: unknown = candidate
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('name' in entry) ||
      !('patterns' in entry) ||
      typeof entry.name !== 'string' ||
      !isOrcaYamlFieldWithinLimit(entry.name) ||
      !Array.isArray(entry.patterns) ||
      entry.patterns.length === 0 ||
      entry.patterns.length > MAX_ORCA_YAML_COLLECTION_ENTRIES ||
      !entry.patterns.every(
        (pattern: unknown): pattern is string =>
          typeof pattern === 'string' && isOrcaYamlFieldWithinLimit(pattern)
      )
    ) {
      continue
    }
    const name = entry.name.trim()
    if (name && !names.has(name)) {
      names.add(name)
      groups.push({ name, patterns: entry.patterns })
    }
  }
  return groups
}
