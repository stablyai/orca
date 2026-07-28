export type RuntimeRpcCallOptions = {
  timeoutMs?: number
  suppressFeatureInteraction?: boolean
  reuseRecentCompatibilityFailure?: boolean
  skipCompatibilityCheck?: boolean
  signal?: AbortSignal
  expectedEnvironmentPairingRevision?: number
}
