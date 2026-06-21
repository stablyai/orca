import type { GitSubmoduleEntry } from './git-status-types'

export function parseGitmodules(raw: string): GitSubmoduleEntry[] {
  const entriesByName = new Map<string, Partial<GitSubmoduleEntry> & { name: string }>()
  let currentName: string | null = null

  for (const line of raw.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[submodule\s+"(.+)"\]\s*(?:[#;].*)?$/)
    if (sectionMatch) {
      currentName = sectionMatch[1]
      if (!entriesByName.has(currentName)) {
        entriesByName.set(currentName, { name: currentName })
      }
      continue
    }

    if (!currentName) {
      continue
    }

    const propertyMatch = line.match(/^\s*([A-Za-z][A-Za-z0-9.-]*)\s*=\s*(.*?)\s*$/)
    if (!propertyMatch) {
      continue
    }

    const entry = entriesByName.get(currentName)
    if (!entry) {
      continue
    }

    const key = propertyMatch[1]
    const value = propertyMatch[2]
    if (key === 'path') {
      entry.path = value
    } else if (key === 'url') {
      entry.url = value
    }
  }

  return Array.from(entriesByName.values()).flatMap((entry) =>
    entry.path
      ? [{ name: entry.name, path: entry.path, ...(entry.url ? { url: entry.url } : {}) }]
      : []
  )
}
