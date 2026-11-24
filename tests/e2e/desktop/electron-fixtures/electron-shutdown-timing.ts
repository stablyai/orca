type ShutdownPhase = 'close' | 'daemon-cleanup' | 'profile-removal'

export function recordElectronShutdownTiming(
  phase: ShutdownPhase,
  started: number,
  details: Record<string, number | string | boolean | null | undefined> = {}
): void {
  if (
    process.env.ORCA_E2E_SHUTDOWN_TIMING !== '1' &&
    process.env.ORCA_E2E_FORWARD_APP_LOGS !== '1'
  ) {
    return
  }
  console.log(
    `[e2e:shutdown] ${JSON.stringify({
      phase,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
      ...details
    })}`
  )
}
