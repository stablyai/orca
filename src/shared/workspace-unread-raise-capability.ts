import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY, type RuntimeCapability } from './protocol-version'

// Why: exactly one side raises a workspace's unread flag. A host advertising this raises it itself
// (ORCA_SIDEBAR_INPUTS=main), so a window raises it only on a host without it. A client advertising
// it leaves raising to such a host; one that hosts browser pages without it raises by its own rule.
export const WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY = 'workspace-unread.host-raises.v1' as const

/** A desktop that raises the flag itself: only desktops host client pages, and every one since
 *  that shipped (#15448) advertises it. */
export function clientRaisesUnreadFlagItself(capabilities: readonly RuntimeCapability[]): boolean {
  return (
    capabilities.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY) &&
    !capabilities.includes(WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY)
  )
}
