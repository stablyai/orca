import type { GlobalSettings } from '../../../../shared/types'

export type GitHostWebSchemes = GlobalSettings['gitHostWebSchemes']

/** Serialize hostname → scheme map as `host=http` lines for the settings field. */
export function formatGitHostWebSchemesText(schemes: GitHostWebSchemes | null | undefined): string {
  return Object.entries(schemes ?? {})
    .filter(([, scheme]) => scheme === 'http' || scheme === 'https')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, scheme]) => `${host}=${scheme}`)
    .join('\n')
}

/** Parse `host=http` lines; invalid rows are skipped. */
export function parseGitHostWebSchemesText(text: string): GitHostWebSchemes {
  const next: Record<string, 'http' | 'https'> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const host = line.slice(0, eq).trim().toLowerCase()
    const scheme = line
      .slice(eq + 1)
      .trim()
      .toLowerCase()
    if (!host || (scheme !== 'http' && scheme !== 'https')) {
      continue
    }
    next[host] = scheme
  }
  return next
}
