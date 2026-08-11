export const RUNTIME_NAVIGATION_TARGETS = ['caller', 'host', 'clients', 'all'] as const

export type RuntimeNavigationTarget = (typeof RUNTIME_NAVIGATION_TARGETS)[number]

export function resolveRuntimeNavigationTarget(args: {
  navigation?: RuntimeNavigationTarget
  notifyClients?: boolean
  clientKind?: 'mobile' | 'runtime'
}): RuntimeNavigationTarget {
  if (args.navigation) {
    return args.navigation
  }
  if (args.clientKind) {
    // Why: legacy paired clients sent notifyClients:true; treating that as navigation lets one device steer every UI.
    return 'caller'
  }
  return args.notifyClients === false ? 'caller' : 'all'
}

export function navigationTargetsHost(target: RuntimeNavigationTarget): boolean {
  return target === 'host' || target === 'all'
}

export function navigationTargetsClients(target: RuntimeNavigationTarget): boolean {
  return target === 'clients' || target === 'all'
}
