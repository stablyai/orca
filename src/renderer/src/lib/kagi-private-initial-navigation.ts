import { normalizeKagiSessionLink, redactKagiSessionToken } from '../../../shared/browser-url'

export type KagiInitialNavigation = {
  modelUrl: string
  navigationUrl: string
}

const MAX_PENDING_NAVIGATIONS = 128
const PENDING_NAVIGATION_TTL_MS = 5 * 60_000
const pendingNavigations = new Map<string, { queuedAt: number; url: string }>()

function prunePendingNavigations(now: number): void {
  for (const [pageId, pending] of pendingNavigations) {
    if (now - pending.queuedAt <= PENDING_NAVIGATION_TTL_MS) {
      break
    }
    pendingNavigations.delete(pageId)
  }
  while (pendingNavigations.size > MAX_PENDING_NAVIGATIONS) {
    const oldestPageId = pendingNavigations.keys().next().value
    if (typeof oldestPageId !== 'string') {
      break
    }
    pendingNavigations.delete(oldestPageId)
  }
}

// Why: queue the validator's canonical link so duplicate `token` params can't send a second bearer to Kagi.
function canonicalizeKagiNavigationUrl(url: string): string | null {
  const normalized = normalizeKagiSessionLink(url)
  if (!normalized) {
    return null
  }
  const query = new URL(url).searchParams.get('q')
  if (query === null) {
    return normalized
  }
  const canonical = new URL(normalized)
  canonical.searchParams.set('q', query)
  return canonical.toString()
}

export function queueKagiPrivateInitialNavigation(pageId: string, url: string): void {
  const canonicalUrl = canonicalizeKagiNavigationUrl(url)
  if (!canonicalUrl) {
    throw new Error('Expected a Kagi private-session URL.')
  }
  const now = Date.now()
  pendingNavigations.delete(pageId)
  pendingNavigations.set(pageId, { queuedAt: now, url: canonicalUrl })
  prunePendingNavigations(now)
}

export function getKagiPrivateInitialNavigation(
  pageId: string,
  modelUrl: string
): KagiInitialNavigation {
  prunePendingNavigations(Date.now())
  const pendingUrl = pendingNavigations.get(pageId)?.url
  const safeModelUrl = redactKagiSessionToken(modelUrl)
  const navigationUrl =
    pendingUrl && redactKagiSessionToken(pendingUrl) === safeModelUrl ? pendingUrl : safeModelUrl
  if (pendingUrl && navigationUrl === safeModelUrl) {
    pendingNavigations.delete(pageId)
  }
  return { modelUrl: safeModelUrl, navigationUrl }
}

export function discardKagiPrivateInitialNavigation(pageId: string): void {
  pendingNavigations.delete(pageId)
}
