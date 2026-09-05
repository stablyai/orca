import { PrioritySemaphore } from '../../../shared/priority-semaphore'

const MAX_CONCURRENT_RECOVERY_RPCS = 4
const MAX_WAITING_RECOVERY_RPCS = 64
let recoveryRpcLane = new PrioritySemaphore(MAX_CONCURRENT_RECOVERY_RPCS)
let waitingRecoveryRpcs = 0

/** Bounds controller inventory/adoption RPCs across all worktrees. */
export async function runInTerminalRecoveryRpcLane<T>(
  isCurrent: () => boolean,
  call: () => Promise<T>
): Promise<T | null> {
  if (waitingRecoveryRpcs >= MAX_WAITING_RECOVERY_RPCS) {
    return null
  }
  waitingRecoveryRpcs += 1
  const release = await recoveryRpcLane.acquire(0)
  waitingRecoveryRpcs -= 1
  try {
    if (!isCurrent()) {
      return null
    }
    return await call()
  } finally {
    release()
  }
}

export function clearTerminalRecoveryRpcLaneForTests(): void {
  recoveryRpcLane = new PrioritySemaphore(MAX_CONCURRENT_RECOVERY_RPCS)
  waitingRecoveryRpcs = 0
}
