import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'

/**
 * Extracts common slug/identifier prefixes from a document name.
 * Examples:
 * - "AgDR-0027-platform-companies" -> ["agdr-0027", "agdr"]
 * - "T464-orca-obsidian-ofm-engine" -> ["t464"]
 * - "2026-09-26-hat-management" -> ["2026-09-26"]
 */
export function extractDocLinkPrefixes(name: string): string[] {
  const prefixes = new Set<string>()
  const lower = name.toLowerCase().trim()

  // Match letters-hyphen-digits: e.g. "agdr-0027", "adr-01", "rfc-1234"
  const letterDashNum = lower.match(/^([a-z]+-\d+)(?:[-_\s]|$)/)
  if (letterDashNum) {
    prefixes.add(letterDashNum[1])
  }

  // Match letter-digits: e.g. "t464", "p12"
  const letterNum = lower.match(/^([a-z]+\d+)(?:[-_\s]|$)/)
  if (letterNum) {
    prefixes.add(letterNum[1])
  }

  // Match ISO date: e.g. "2026-09-26"
  const datePrefix = lower.match(/^(\d{4}-\d{2}-\d{2})(?:[-_\s]|$)/)
  if (datePrefix) {
    prefixes.add(datePrefix[1])
  }

  // Leading token before first hyphen or underscore: e.g. "proposal-draft" -> "proposal"
  const firstSep = lower.search(/[-_]/)
  if (firstSep > 1) {
    prefixes.add(lower.slice(0, firstSep))
  }

  return Array.from(prefixes)
}

/**
 * Deterministically disambiguates multiple candidate matches for a doc link.
 * Precedence:
 * 1. Non-archived documents preferred over archived documents.
 * 2. Shorter relative path length (closer to root / less deeply nested).
 * 3. Deterministic alphabetical ordering.
 */
export function disambiguateMatches(matches: MarkdownDocument[]): MarkdownDocument {
  if (matches.length === 1) {
    return matches[0]
  }

  const sorted = [...matches].sort((a, b) => {
    const aArchive = a.relativePath.includes('/archive/') || a.relativePath.startsWith('archive/')
    const bArchive = b.relativePath.includes('/archive/') || b.relativePath.startsWith('archive/')
    if (aArchive !== bArchive) {
      return aArchive ? 1 : -1
    }
    if (a.relativePath.length !== b.relativePath.length) {
      return a.relativePath.length - b.relativePath.length
    }
    return a.relativePath.localeCompare(b.relativePath)
  })

  return sorted[0]
}

/**
 * Resolves a doc link target using frontmatter aliases, indexed slug prefixes,
 * or filename prefix scans with deterministic disambiguation.
 */
export function resolveDocLinkSlugOrAlias(
  extensionlessTarget: string,
  index: {
    byPrefix?: Map<string, MarkdownDocument[]>
    byAlias?: Map<string, MarkdownDocument[]>
    documents?: MarkdownDocument[]
  }
): { status: 'resolved'; document: MarkdownDocument } | null {
  if (index.byAlias) {
    const aliasMatches = index.byAlias.get(extensionlessTarget)
    if (aliasMatches && aliasMatches.length > 0) {
      return { status: 'resolved', document: disambiguateMatches(aliasMatches) }
    }
  }

  if (index.byPrefix) {
    const prefixMatches = index.byPrefix.get(extensionlessTarget)
    if (prefixMatches && prefixMatches.length > 0) {
      return { status: 'resolved', document: disambiguateMatches(prefixMatches) }
    }
  }

  if (index.documents) {
    const slugMatches = index.documents.filter((doc) => {
      const docName = doc.name.toLowerCase().trim()
      return (
        docName.startsWith(`${extensionlessTarget}-`) ||
        docName.startsWith(`${extensionlessTarget}_`)
      )
    })
    if (slugMatches.length > 0) {
      return { status: 'resolved', document: disambiguateMatches(slugMatches) }
    }
  }

  return null
}
