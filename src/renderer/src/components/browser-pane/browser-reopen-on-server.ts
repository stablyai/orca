import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-browser-creation'

/** Restore only committed web URLs across engines; other destinations reopen blank and request bodies are never reconstructed. */
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

/** Placement is immutable per generation: create a separate server page without mutating the client-hosted one. */
export async function reopenBrowserPageOnServer(args: {
  environmentId: string
  worktreeId: string
  lastCommittedUrl: string | null | undefined
}): Promise<boolean> {
  return createWebRuntimeSessionBrowserTab({
    worktreeId: args.worktreeId,
    environmentId: args.environmentId,
    url: resolveBrowserReopenOnServerUrl(args.lastCommittedUrl),
    placementPreference: 'server',
    focusOnCreate: true
  })
}
