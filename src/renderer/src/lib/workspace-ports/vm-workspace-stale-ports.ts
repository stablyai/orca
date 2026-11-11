// A workspace whose VM sleeps loses every process on sleep (stop is a reboot), so a port found
// before the sleep must not show while it is asleep, while it wakes, or after the wake until a
// scan taken since then finds it again (JA-13).

type VmRuntimeLike = { status: string; updatedAt?: number } | undefined

export function vmWorkspacePortsAreStale(args: {
  runtime: VmRuntimeLike
  waking: boolean
  scannedAt: number | null | undefined
}): boolean {
  const { runtime, waking, scannedAt } = args
  if (!runtime) {
    return false
  }
  if (waking || runtime.status === 'suspended' || runtime.status === 'resume_failed') {
    return true
  }
  // The scan predates the last lifecycle change (the wake): its ports are from before the sleep.
  return (
    runtime.updatedAt !== undefined &&
    typeof scannedAt === 'number' &&
    scannedAt < runtime.updatedAt
  )
}
