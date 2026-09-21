import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-session'

/**
 * Last committed URL, reduced to what is safe to restore on another browser engine.
 * A blank or non-web destination reopens blank rather than replaying something the
 * new page cannot reproduce; Orca never reconstructs a request body.
 */
export function resolveBrowserReopenOnServerUrl(
  url: string | null | undefined
): string | undefined {
  if (typeof url !== 'string') {
    return undefined
  }
  let normalized: string | null = null
  try {
    normalized = normalizeBrowserNavigationUrl(url)
  } catch {
    return undefined
  }
  if (!normalized || normalized === ORCA_BROWSER_BLANK_URL || normalized.startsWith('file:')) {
    return undefined
  }
  return normalized
}

/**
 * Creates a NEW server-placed page. Placement is immutable per page generation, so the
 * client-hosted page is left alone — this never migrates or mutates it.
 */
export async function reopenBrowserPageOnServer(args: {
  environmentId: string
  worktreeId: string
  lastCommittedUrl: string | null | undefined
}): Promise<boolean> {
  return createWebRuntimeSessionBrowserTab({
    worktreeId: args.worktreeId,
    environmentId: args.environmentId,
    url: resolveBrowserReopenOnServerUrl(args.lastCommittedUrl),
    // Omitting client placement is what `browser.tabCreate` reads as server placement.
    placementPreference: 'server',
    focusOnCreate: true
  })
}
