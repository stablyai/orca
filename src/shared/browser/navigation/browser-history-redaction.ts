import { redactBrowserMetadata } from '../browser-metadata-redaction'

type HistoryEntry = { url: string; title: string; pageState?: string }

function isKagiPage(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && ['kagi.com', 'www.kagi.com'].includes(url.hostname)
  } catch {
    return false
  }
}

export function redactBrowserHistorySnapshot(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.map((entry) => {
    const safe = redactBrowserMetadata(entry)
    // Chromium pageState can retain the previous URL after history.replaceState, so a Kagi
    // entry's state can hold its token even once the address lost it. Kagi sends
    // strict-origin-when-cross-origin, so other sites' entries only see its bare origin.
    if (safe === entry && !isKagiPage(entry.url)) {
      return entry
    }
    return { url: safe.url, title: safe.title }
  })
}
