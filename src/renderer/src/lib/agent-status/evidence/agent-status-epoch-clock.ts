// Sample during render once per freshness epoch so consumers agree and expiry paints immediately without another state update.
export function createAgentStatusEpochClock(
  // Call through Date.now so later-installed fake timers replace the clock.
  readNow: () => number = () => Date.now()
): (agentStatusEpoch: number) => number {
  let sampledEpoch: number | null = null
  let sampledNow = 0

  return (agentStatusEpoch) => {
    if (sampledEpoch !== agentStatusEpoch) {
      sampledEpoch = agentStatusEpoch
      sampledNow = readNow()
    }
    return sampledNow
  }
}

let sharedClock = createAgentStatusEpochClock()

/** Read only with a subscribed live epoch; sentinel epochs must not evict the shared sample. The scheduler must bump every stale boundary or expired rows stay live until another bump. */
export const getAgentStatusEpochNow = (agentStatusEpoch: number): number =>
  sharedClock(agentStatusEpoch)

/** Reset with store epochs in tests or epoch 0 can reuse an earlier test’s timestamp. */
export function resetAgentStatusEpochClockForTests(): void {
  sharedClock = createAgentStatusEpochClock()
}
