// VPN/Tailscale routes can recover without online events; a ready control socket proves reachability and revives latched panes like Reconnect.
export type RemoteRuntimePtyReviver = {
  /** The server answered: clear any sign-in wait and replay. */
  onControlReady: () => boolean
  /** The user asked to try now: replay, but leave a pane waiting for SSH sign-in to its own prompt. */
  onManualRetry: () => boolean
}

const controlReadyRevivers = new Map<string, Set<RemoteRuntimePtyReviver>>()

export function registerRemoteRuntimePtyControlReadyReviver(
  environmentId: string,
  reviver: RemoteRuntimePtyReviver
): () => void {
  let revivers = controlReadyRevivers.get(environmentId)
  if (!revivers) {
    revivers = new Set()
    controlReadyRevivers.set(environmentId, revivers)
  }
  revivers.add(reviver)
  return () => {
    const current = controlReadyRevivers.get(environmentId)
    current?.delete(reviver)
    if (current?.size === 0) {
      controlReadyRevivers.delete(environmentId)
    }
  }
}

function reviveEach(
  environmentId: string,
  revive: (reviver: RemoteRuntimePtyReviver) => boolean
): number {
  let revived = 0
  for (const reviver of Array.from(controlReadyRevivers.get(environmentId) ?? [])) {
    if (revive(reviver)) {
      revived += 1
    }
  }
  return revived
}

export function reviveRemoteRuntimePtyRecoveriesForEnvironment(environmentId: string): number {
  return reviveEach(environmentId, (reviver) => reviver.onControlReady())
}

/** A Reconnect click for one server: advances its panes' backoffs and replays latched panes. */
export function retryRemoteRuntimePtyRecoveriesForEnvironment(environmentId: string): number {
  return reviveEach(environmentId, (reviver) => reviver.onManualRetry())
}
