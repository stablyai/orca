/**
 * Evidence that a folder workspace was re-pointed at a different SSH host.
 *
 * A workspace-pinned record captures only a generation, so a capture that
 * disagrees with the pin's current registration is ambiguous on its face: the
 * workspace may have moved to another host, or the pinned host may have been
 * removed and re-added under the same id. Those need opposite answers — follow
 * the pin, or stay fenced — so the divergence is resolved from evidence rather
 * than guessed.
 *
 * Generations come from one counter and are never reissued, so at most one
 * registration ever carries a given generation. A *live* registration carrying
 * the capture is therefore proof of which pin the record was attached to, and
 * proof it is not this one. No live carrier proves nothing, and the positive-
 * evidence rule leaves the capture alone there: an unfenced re-adopt would hand
 * the schedule to whatever machine now answers to the pinned id.
 */

import type { AutomationWorkspaceSshPin } from './automation-workspace-pin'
import { sanitizeSshTargetGeneration } from './ssh-target-generation'

/** The registration a generation was allocated to, if one still carries it. */
export type SshTargetIdForGeneration = (generation: number) => string | undefined

export function isWorkspaceSshPinRepinned(input: {
  capturedGeneration: number | undefined
  pin: AutomationWorkspaceSshPin | undefined
  sshTargetIdForGeneration: SshTargetIdForGeneration | undefined
}): boolean {
  const captured = sanitizeSshTargetGeneration(input.capturedGeneration)
  const pin = input.pin
  if (captured === undefined || pin?.generation === undefined || captured === pin.generation) {
    return false
  }
  const capturedTargetId = input.sshTargetIdForGeneration?.(captured)
  return capturedTargetId !== undefined && capturedTargetId !== pin.targetId
}
