import type { PinnedWebPanel } from './types'

// Why: panels host arbitrary user URLs in privileged-adjacent webviews, so a
// bound keeps a corrupted profile from flooding the sidebar and the partition.
export const MAX_PINNED_WEB_PANELS = 12

// Why: panels share one persistent session so dashboard logins survive
// relaunch, but stay out of the interactive browser's partitions — panel
// guests are chromeless and must not inherit or pollute browser cookies.
// Lives in shared because main's will-attach-webview allowlist and the
// renderer's webview host must agree on the exact string.
export const PINNED_WEB_PANEL_PARTITION = 'persist:pinned-web-panels'

/** Ad-hoc canvas blank browsers — separate cookies from pinned dashboards. */
export const CANVAS_BROWSER_PARTITION = 'persist:canvas-browser'

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
    const { id, title, url, groupId, order } = entry as Record<string, unknown>
    const normalizedUrl = normalizePinnedWebPanelUrl(url)
    if (typeof id !== 'string' || id.length === 0 || seenIds.has(id) || normalizedUrl === null) {
      continue
    }
    const trimmedTitle =
      typeof title === 'string' ? title.trim().slice(0, MAX_PANEL_TITLE_LENGTH) : ''
    const trimmedGroupId =
      typeof groupId === 'string' && groupId.trim().length > 0 ? groupId.trim() : ''
    const orderNum =
      typeof order === 'number' && Number.isFinite(order) ? Math.trunc(order) : undefined
    seenIds.add(id)
    panels.push({
      id,
      // Why: an empty title renders an unclickable-looking blank row; fall
      // back to the host so the entry stays identifiable.
      title: trimmedTitle.length > 0 ? trimmedTitle : new URL(normalizedUrl).host,
      url: normalizedUrl,
      ...(trimmedGroupId.length > 0 ? { groupId: trimmedGroupId } : {}),
      ...(orderNum !== undefined ? { order: orderNum } : {})
    })
  }
  return panels
}
