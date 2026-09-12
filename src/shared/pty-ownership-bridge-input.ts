import type { PtyOwnershipBridgeInputFrame } from './pty-ownership-bridge-contract'
import { PtyOwnershipBridgeError } from './pty-ownership-bridge-errors'
import type { PtyOwnershipBridgeRole } from './pty-ownership-bridge-role'
import type { PtyOwnershipBridgeState } from './pty-ownership-bridge-state'

export function acceptPtyOwnershipBridgeInput(
  state: PtyOwnershipBridgeState,
  role: PtyOwnershipBridgeRole,
  frame: PtyOwnershipBridgeInputFrame,
  write: (data: string) => void,
  inputDeduplication: boolean
): { accepted: boolean; duplicate: boolean } {
  if (role === 'source' && state.phase !== 'idle' && state.phase !== 'aborted') {
    throw new PtyOwnershipBridgeError(
      'invalid-phase',
      'source input is fenced during ownership transfer'
    )
  }
  if (role === 'destination' && state.phase !== 'committed') {
    throw new PtyOwnershipBridgeError(
      'invalid-phase',
      'destination input is unavailable before commit'
    )
  }
  if (!inputDeduplication) {
    throw new PtyOwnershipBridgeError(
      'input-deduplication-unavailable',
      'input deduplication was not negotiated'
    )
  }
  if (!frame.inputId || typeof frame.data !== 'string') {
    throw new PtyOwnershipBridgeError('input-conflict', 'input frame is malformed')
  }
  const previous = state.acceptedInputIds.get(frame.inputId)
  if (previous !== undefined) {
    if (previous !== frame.data) {
      throw new PtyOwnershipBridgeError('input-conflict', `input ID ${frame.inputId} changed`)
    }
    return { accepted: false, duplicate: true }
  }
  if (state.acceptedInputIds.size >= state.inputIds) {
    throw new PtyOwnershipBridgeError(
      'input-deduplication-window-exhausted',
      'input deduplication window is full; pause migration until it can be retired'
    )
  }
  state.acceptedInputIds.set(frame.inputId, frame.data)
  write(frame.data)
  return { accepted: true, duplicate: false }
}

export function retirePtyOwnershipBridgeInputIds(
  state: PtyOwnershipBridgeState,
  role: PtyOwnershipBridgeRole,
  inputIds: readonly string[]
): number {
  if (role !== 'destination' || state.phase !== 'committed') {
    throw new PtyOwnershipBridgeError(
      'invalid-phase',
      'input IDs can only be retired by the committed destination'
    )
  }
  for (const inputId of inputIds) {
    if (typeof inputId !== 'string' || inputId.length === 0) {
      throw new PtyOwnershipBridgeError('input-conflict', 'input ID is malformed')
    }
  }
  let retired = 0
  for (const inputId of inputIds) {
    if (state.acceptedInputIds.delete(inputId)) {
      retired += 1
    }
  }
  return retired
}
