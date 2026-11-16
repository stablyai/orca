/**
 * What each mounted plugin panel has drawn, so `orca plugin shot` can wait for the current guest
 * (not the last good tree of the one a dev save replaced) before main captures it.
 */
export type PluginPanelDrawStatus = {
  ui: 'components' | 'html'
  /** The guest whose output is on screen, or the one still loading. */
  guestUrl: string | null
  /** True once that guest drew (its first accepted tree, or its document loaded) or erred. */
  drawn: boolean
  /** The panel's own error banner, if it shows one. */
  issue: string | null
  /** Set when the panel cannot draw at all (load failed, suspended). */
  failure: string | null
}

const statuses = new Map<string, PluginPanelDrawStatus>()
const listeners = new Set<() => void>()

export function reportPluginPanelDraw(tabKey: string, status: PluginPanelDrawStatus | null): void {
  if (status) {
    statuses.set(tabKey, status)
  } else {
    statuses.delete(tabKey)
  }
  for (const listener of listeners) {
    listener()
  }
}

export function pluginPanelDrawStatus(tabKey: string): PluginPanelDrawStatus | null {
  return statuses.get(tabKey) ?? null
}

export function subscribePluginPanelDraw(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The `rev` query value main stamps on every guest URL. */
export function pluginGuestUrlRevision(url: string | null): string | null {
  const match = url ? /[?&]rev=([^&#]*)/.exec(url) : null
  if (!match) {
    return null
  }
  try {
    return decodeURIComponent(match[1] ?? '')
  } catch {
    return null
  }
}

/** Done waiting: the panel failed, or the guest of `revision` (null: any) has drawn. */
export function isPluginPanelDrawSettled(
  status: PluginPanelDrawStatus | null,
  revision: string | null
): boolean {
  if (!status) {
    return false
  }
  if (status.failure !== null) {
    return true
  }
  const current = revision === null || pluginGuestUrlRevision(status.guestUrl) === revision
  return current && status.drawn
}
