import { redactBrowserMetadata } from '../browser-metadata-redaction'

type HistoryEntry = { url: string; title: string; pageState?: string }

export function redactBrowserHistorySnapshot(entries: HistoryEntry[]): HistoryEntry[] {
  const safe = entries.map((entry) => redactBrowserMetadata(entry))
  // Chromium pageState can retain the previous URL after history.replaceState.
  const privateHistory = entries.some((entry, index) => {
    if (safe[index] !== entry) {
      return true
    }
    try {
      const url = new URL(entry.url)
      return url.protocol === 'https:' && ['kagi.com', 'www.kagi.com'].includes(url.hostname)
    } catch {
      return false
    }
  })
  return privateHistory ? safe.map(({ url, title }) => ({ url, title })) : safe
}
