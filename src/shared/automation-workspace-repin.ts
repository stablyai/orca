/** Generation mismatch may mean workspace movement or same-ID host replacement, requiring opposite decisions. Globally nonreissued generations prove the old pin only while another live registration carries the capture. Without positive evidence retain fencing; guessing could hand schedules to a replacement machine. */

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
