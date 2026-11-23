import type { DetectedBrowserEntry } from './browser-toolbar-import-cookies-item'

/** One importable source: a browser, plus the profile directory when it has several. */
export type BrowserCookieImportSource = {
  family: string
  profile: string | null
}

export type BrowserCookieImportPickerRow = {
  /** Unique within the picker; cmdk's highlight identity. */
  value: string
  label: string
  source: BrowserCookieImportSource
}

export type BrowserCookieImportPickerSection = {
  /** Null for "Last used", whose label the picker translates. */
  browserLabel: string | null
  key: string
  rows: BrowserCookieImportPickerRow[]
}

function sourceValue(source: BrowserCookieImportSource): string {
  return `${source.family}\u001f${source.profile ?? ''}`
}

/** A browser with one profile imports without naming it, as its single row is named after the browser. */
function browserRows(browser: DetectedBrowserEntry): BrowserCookieImportPickerRow[] {
  if (browser.profiles.length <= 1) {
    const source = { family: browser.family, profile: null }
    return [{ value: sourceValue(source), label: browser.label, source }]
  }
  return browser.profiles.map((profile) => {
    const source = { family: browser.family, profile: profile.directory }
    return { value: sourceValue(source), label: profile.name, source }
  })
}

function matchText(browser: DetectedBrowserEntry, profileDirectory: string | null): string {
  const profile = browser.profiles.find((p) => p.directory === profileDirectory)
  return `${browser.label} ${profile?.name ?? browser.profiles[0]?.name ?? ''}`.toLowerCase()
}

/** "<Browser> · <Profile>" for the last source, or null when that browser or profile is gone. */
function lastUsedRow(
  browsers: readonly DetectedBrowserEntry[],
  lastUsed: BrowserCookieImportSource
): BrowserCookieImportPickerRow | null {
  const browser = browsers.find((b) => b.family === lastUsed.family)
  if (!browser) {
    return null
  }
  const row = browserRows(browser).find((r) => r.source.profile === lastUsed.profile)
  if (!row) {
    return null
  }
  return {
    value: `last\u001f${row.value}`,
    label: lastUsed.profile === null ? browser.label : `${browser.label} · ${row.label}`,
    source: row.source
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
  const last = !searching && lastUsed ? lastUsedRow(browsers, lastUsed) : null
  if (last) {
    sections.push({ browserLabel: null, key: 'last-used', rows: [last] })
  }
  for (const browser of browsers) {
    const rows = browserRows(browser).filter((row) => {
      const text = matchText(browser, row.source.profile)
      return words.every((word) => text.includes(word))
    })
    if (rows.length > 0) {
      sections.push({ browserLabel: browser.label, key: browser.family, rows })
    }
  }
  return sections
}
