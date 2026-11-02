import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY, type RuntimeCapability } from './protocol-version'

// Raise unread on exactly one side: capable hosts own it, and capable clients defer to them. Legacy hosts and client-hosted pages need client-side raising.
export const WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY = 'workspace-unread.host-raises.v1' as const

/** Only desktops host client pages; all builds since that feature (#15448) advertise their own unread raising. */
export function clientRaisesUnreadFlagItself(capabilities: readonly RuntimeCapability[]): boolean {
  return (
    capabilities.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY) &&
    !capabilities.includes(WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY)
  )
}
