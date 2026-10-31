import {
  perforceWorkspaceKey,
  runPerforceOperation,
  type PerforceWorkspaceTarget
} from '../runtime/runtime-perforce-client'

// Why: detection shells out to `p4 info` (over SSH or on an Orca server), so remember answers per workspace.
const detectionByKey = new Map<string, Promise<boolean>>()
const knownWorkspaces = new Set<string>()

/** Synchronous answer for key handlers: true only after a positive detection this session. */
export function isKnownPerforceWorkspace(target: PerforceWorkspaceTarget): boolean {
  return knownWorkspaces.has(perforceWorkspaceKey(target))
}

export function isPerforceDetectionPending(key: string): boolean {
  return detectionByKey.has(key)
}

/** Drops the remembered answer so the next detection asks p4 again. */
export function forgetPerforceDetection(key: string): void {
  detectionByKey.delete(key)
  knownWorkspaces.delete(key)
}

export function detectPerforceWorkspace(target: PerforceWorkspaceTarget): Promise<boolean> {
  const key = perforceWorkspaceKey(target)
  let pending = detectionByKey.get(key)
  if (!pending) {
    pending = Promise.resolve()
      .then(() => runPerforceOperation(target, 'detect', {}))
      .then((result) => {
        // Only positive answers are remembered so a later p4 setup/login is detected on retry.
        if (result.isWorkspace) {
          knownWorkspaces.add(key)
        } else {
          forgetPerforceDetection(key)
        }
        return result.isWorkspace
      })
      .catch(() => {
        detectionByKey.delete(key)
        return false
      })
    detectionByKey.set(key, pending)
  }
  return pending
}

// Why a few minutes: a plain folder project is not asked p4 on every save, yet a workspace set up
// later is still found.
const NOT_PERFORCE_RECHECK_MS = 5 * 60_000
const notPerforceUntil = new Map<string, number>()

/** For saves and diffs: true for a workspace detected now or earlier this session. */
export async function isPerforceWorkspaceForFiles(
  target: PerforceWorkspaceTarget
): Promise<boolean> {
  const key = perforceWorkspaceKey(target)
  if (knownWorkspaces.has(key)) {
    return true
  }
  if ((notPerforceUntil.get(key) ?? 0) > Date.now()) {
    return false
  }
  const detected = await detectPerforceWorkspace(target)
  if (detected) {
    notPerforceUntil.delete(key)
  } else {
    notPerforceUntil.set(key, Date.now() + NOT_PERFORCE_RECHECK_MS)
  }
  return detected
}
