import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'
import { resolveLocalTabIdForHostSessionTab } from '@/runtime/web-session-tabs-sync/tracking-mappings'

/** Main addresses its own session-tab ids; a mirrored chat tab lives here under a different id. */
export function resolveWindowTabIdForHostTab(worktreeId: string, tabId: string): string {
  return (
    resolveLocalTabIdForHostSessionTab({
      environmentId: LOCAL_STRUCTURED_SESSION_OWNER,
      worktreeId,
      hostTabId: tabId
    }) ?? tabId
  )
}
