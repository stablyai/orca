import type { DetectedBrowserEntry } from './browser-toolbar-import-cookies-item'

export type BrowserCookieImportSource = {
  family: string
  /** Null for a browser that reported no profiles. */
  profile: string | null
}

export type BrowserCookieImportPickerRow = {
  /** Unique within the picker; cmdk's highlight identity. */
  value: string
  label: string
  source: BrowserCookieImportSource
  /** Lowercased "browser profile", the text a search matches. */
  searchText: string
}

export type BrowserCookieImportPickerSection = {
  /** "Last used" is labelled by the picker, which translates it. */
  kind: 'last-used' | 'browser'
  /** Null where the section has no label: "Last used", and a browser whose one row already names it. */
  browserLabel: string | null
  key: string
  rows: BrowserCookieImportPickerRow[]
}

function sourceValue(source: BrowserCookieImportSource): string {
  return `${source.family}\u001f${source.profile ?? ''}`
}

/** One pass over the profiles; a one-profile browser is a single row named after the browser. */
function browserRows(browser: DetectedBrowserEntry): BrowserCookieImportPickerRow[] {
  const single = browser.profiles.length <= 1
  const profiles = browser.profiles.length > 0 ? browser.profiles : [null]
  return profiles.map((profile) => {
    const name = profile?.name ?? ''
    const source = { family: browser.family, profile: profile?.directory ?? null }
    return {
      value: sourceValue(source),
      label: single ? browser.label : name,
      source,
      searchText: `${browser.label} ${name}`.toLowerCase()
    }
  })
}

/** "<Browser> · <Profile>" for the last source, or null when that browser or profile is gone. */
function lastUsedRow(
  browser: DetectedBrowserEntry,
  rows: readonly BrowserCookieImportPickerRow[],
  lastUsed: BrowserCookieImportSource
): BrowserCookieImportPickerRow | null {
  const row = rows.find((r) => r.source.profile === lastUsed.profile)
  if (!row) {
    return null
  }
  return {
    ...row,
    value: `last\u001f${row.value}`,
    label: browser.profiles.length > 1 ? `${browser.label} · ${row.label}` : browser.label
  }
}

/** Sections in display order: "Last used" (empty search only), then one per browser with matching rows. */
export function buildBrowserCookieImportPickerSections(
  browsers: readonly DetectedBrowserEntry[],
  lastUsed: BrowserCookieImportSource | null,
  query: string
): BrowserCookieImportPickerSection[] {
  // Every word must appear, so "chrome work" finds Chrome's Work profile.
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const searching = words.length > 0
  const sections: BrowserCookieImportPickerSection[] = []
  let last: BrowserCookieImportPickerRow | null = null
  for (const browser of browsers) {
    const rows = browserRows(browser)
    if (!searching && lastUsed?.family === browser.family) {
      last ??= lastUsedRow(browser, rows, lastUsed)
    }
    const matching = rows.filter((row) => words.every((word) => row.searchText.includes(word)))
    if (matching.length > 0) {
      sections.push({
        kind: 'browser',
        browserLabel: browser.profiles.length > 1 ? browser.label : null,
        key: browser.family,
        rows: matching
      })
    }
  }
  if (last) {
    sections.unshift({ kind: 'last-used', browserLabel: null, key: 'last-used', rows: [last] })
  }
  return sections
}
