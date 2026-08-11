export const DIRECT_SSH_RECONNECT_SESSION_ROUTE_KEY = 'orca.directSshReconnectCoordinator.enabled'

export function resolveDirectSshReconnectCoordinatorRouting(args: {
  buildValue?: string
  sessionValue?: string | null
}): boolean {
  if (args.buildValue?.trim().toLowerCase() === 'false') {
    return false
  }
  return args.sessionValue?.trim().toLowerCase() !== 'false'
}

export function isDirectSshReconnectCoordinatorRoutingEnabled(): boolean {
  let sessionValue: string | null = null
  try {
    sessionValue =
      globalThis.sessionStorage?.getItem(DIRECT_SSH_RECONNECT_SESSION_ROUTE_KEY) ?? null
  } catch {
    // Storage can be unavailable in privacy-restricted renderer sessions.
  }
  return resolveDirectSshReconnectCoordinatorRouting({
    buildValue: import.meta.env.VITE_DIRECT_SSH_RECONNECT_COORDINATOR,
    sessionValue
  })
}
