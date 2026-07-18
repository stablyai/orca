import type { PinnedWebPanel } from './types'

// Why: panels host arbitrary user URLs in privileged-adjacent webviews, so a
// bound keeps a corrupted profile from flooding the sidebar and the partition.
export const MAX_PINNED_WEB_PANELS = 12

const MAX_PANEL_TITLE_LENGTH = 60

function normalizePinnedWebPanelUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    const parsed = new URL(value.trim())
    // Why: only web pages belong in a panel — file:, javascript:, and custom
    // schemes would run outside the browser-guest security model.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

/** Drops malformed entries instead of failing the whole settings write, so one
 *  bad panel (hand-edited profile, older build) can't wedge the rest. */
export function normalizePinnedWebPanels(value: unknown): PinnedWebPanel[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seenIds = new Set<string>()
  const panels: PinnedWebPanel[] = []
  for (const entry of value) {
    if (panels.length >= MAX_PINNED_WEB_PANELS) {
      break
    }
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const { id, title, url } = entry as Record<string, unknown>
    const normalizedUrl = normalizePinnedWebPanelUrl(url)
    if (typeof id !== 'string' || id.length === 0 || seenIds.has(id) || normalizedUrl === null) {
      continue
    }
    const trimmedTitle =
      typeof title === 'string' ? title.trim().slice(0, MAX_PANEL_TITLE_LENGTH) : ''
    seenIds.add(id)
    panels.push({
      id,
      // Why: an empty title renders an unclickable-looking blank row; fall
      // back to the host so the entry stays identifiable.
      title: trimmedTitle.length > 0 ? trimmedTitle : new URL(normalizedUrl).host,
      url: normalizedUrl
    })
  }
  return panels
}
