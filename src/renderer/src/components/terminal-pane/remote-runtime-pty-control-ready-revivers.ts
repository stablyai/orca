// VPN/Tailscale routes can recover without online events; a ready control socket proves reachability and revives latched panes like Reconnect.
const controlReadyRevivers = new Map<string, Set<() => boolean>>()

export function registerRemoteRuntimePtyControlReadyReviver(
  environmentId: string,
  revive: () => boolean
): () => void {
  let revivers = controlReadyRevivers.get(environmentId)
  if (!revivers) {
    revivers = new Set()
    controlReadyRevivers.set(environmentId, revivers)
  }
  revivers.add(revive)
  return () => {
    const current = controlReadyRevivers.get(environmentId)
    current?.delete(revive)
    if (current?.size === 0) {
      controlReadyRevivers.delete(environmentId)
    }
  }
}

export function getControlReadyReviverCountForTests(environmentId: string): number {
  return controlReadyRevivers.get(environmentId)?.size ?? 0
}

export function reviveRemoteRuntimePtyRecoveriesForEnvironment(environmentId: string): number {
  let revived = 0
  for (const revive of Array.from(controlReadyRevivers.get(environmentId) ?? [])) {
    if (revive()) {
      revived += 1
    }
  }
  return revived
}
