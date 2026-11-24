// Reconnect snapshots may retain the last epoch/version and fail freshness gates (#7718); tag the first replay
// response as authoritative. Tag only after client-side parsing so old-server wire compatibility is unchanged.

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
