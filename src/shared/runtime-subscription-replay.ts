// Why: after a shared-control reconnect, the client replays its logical
// subscriptions and the server re-emits each stream's current snapshot. When
// the host did not restart, that snapshot carries the same publicationEpoch/
// snapshotVersion the client already applied, so monotonic freshness gates
// (e.g. shouldApplyWebSessionTabsSnapshot) would silently drop it and leave
// mirrors frozen (#7718). The connection tags the first response delivered
// after a replay so consumers can treat it as authoritative. The tag is added
// client-side after wire parsing — nothing changes on the protocol, so old
// servers are unaffected.

const RUNTIME_SUBSCRIPTION_REPLAY_FLAG = '_replayedAfterReconnect'

export function tagRuntimeSubscriptionReplayResponse<TResponse extends object>(
  response: TResponse
): TResponse {
  return { ...response, [RUNTIME_SUBSCRIPTION_REPLAY_FLAG]: true }
}

export function isRuntimeSubscriptionReplayResponse(response: unknown): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as Record<string, unknown>)[RUNTIME_SUBSCRIPTION_REPLAY_FLAG] === true
  )
}
