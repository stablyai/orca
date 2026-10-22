import { BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY } from '../../../../../shared/browser-runtime-capabilities'
import { isFrameDrawnServerWorkspace } from '@/runtime/web-session-tabs-sync/frame-drawn-server-workspaces'

/** A server's browser tab a page of this desktop's joins, in a workspace the server's frames draw. */
export type FrameDrawnServerBrowserTab = {
  browserTabId: string
  /** The host keeps a create's page id, so the page it runs is the one this desktop drew. */
  hostKnowsPageIds: boolean
}

export function frameDrawnServerBrowserTab(args: {
  environmentId: string
  worktreeId: string
  browserTabId: string
  capabilities: readonly string[]
}): FrameDrawnServerBrowserTab | null {
  if (!isFrameDrawnServerWorkspace(args.environmentId, args.worktreeId)) {
    return null
  }
  return {
    browserTabId: args.browserTabId,
    hostKnowsPageIds: args.capabilities.includes(BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY)
  }
}
