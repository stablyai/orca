import { BEADS_TASK_SOURCE_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { TaskResumeState } from '../../../shared/ui-chrome-types'

type UiSetTaskResumeUpdates = { taskResumeState?: TaskResumeState }

const BEADS_TASK_RESUME_KEYS = ['beadsPreset', 'beadsQuery'] as const

/**
 * Pre-beads hosts parse `taskResumeState` strictly: the oldest fail the WHOLE
 * `ui.set` with invalid_argument, newer ones drop the entire field via value
 * tolerance and report success. Either way one beads key silently kills
 * github/jira resume persistence host-side, so beads keys must never reach a
 * host that predates the beads capability.
 */
export function taskResumeStateHasBeadsKeys(updates: UiSetTaskResumeUpdates): boolean {
  const resume = updates.taskResumeState
  return resume !== undefined && BEADS_TASK_RESUME_KEYS.some((key) => key in resume)
}

export function stripBeadsTaskResumeKeys<T extends UiSetTaskResumeUpdates>(updates: T): T {
  if (!updates.taskResumeState) {
    return updates
  }
  const { beadsPreset: _preset, beadsQuery: _query, ...taskResumeState } = updates.taskResumeState
  return { ...updates, taskResumeState }
}

type BeadsCapabilityCacheEntry = { supported: boolean; checkedAt: number }
// Why: supported never regresses, but an unsupported host can be upgraded in place — recheck those.
const UNSUPPORTED_RECHECK_MS = 60_000
const capabilityByEnvironmentId = new Map<string, BeadsCapabilityCacheEntry>()

/** Strips beads keys from `taskResumeState` unless the paired host advertises the beads capability. */
export async function gateTaskResumeStateForHost<T extends UiSetTaskResumeUpdates>(args: {
  updates: T
  environmentId: string | null
  getStatus: () => Promise<RuntimeStatus>
}): Promise<T> {
  const { updates, environmentId, getStatus } = args
  if (!taskResumeStateHasBeadsKeys(updates)) {
    return updates
  }
  if (!environmentId) {
    return stripBeadsTaskResumeKeys(updates)
  }
  const cached = capabilityByEnvironmentId.get(environmentId)
  if (cached && (cached.supported || Date.now() - cached.checkedAt < UNSUPPORTED_RECHECK_MS)) {
    return cached.supported ? updates : stripBeadsTaskResumeKeys(updates)
  }
  try {
    const status = await getStatus()
    const supported = status.capabilities?.includes(BEADS_TASK_SOURCE_RUNTIME_CAPABILITY) === true
    capabilityByEnvironmentId.set(environmentId, { supported, checkedAt: Date.now() })
    return supported ? updates : stripBeadsTaskResumeKeys(updates)
  } catch {
    // Probe failure is uncached: send the safe stripped shape and re-probe next write.
    return stripBeadsTaskResumeKeys(updates)
  }
}

export function clearBeadsTaskResumeCapabilityCacheForTests(): void {
  capabilityByEnvironmentId.clear()
}
