import {
  PtyOwnershipTransferDestinationError,
  type DestinationAdapterState
} from './pty-ownership-transfer-destination-adapter-contract'
import { requireDestinationRecord } from './pty-ownership-transfer-destination-adapter-state'

export function acceptDestinationInput(
  state: DestinationAdapterState,
  inputId: string,
  data: string
): { accepted: boolean; duplicate: boolean } {
  const record = requireDestinationRecord(state)
  if (record.phase !== 'committed' && record.phase !== 'published') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'destination input is unavailable before commit'
    )
  }
  if (!inputId || typeof data !== 'string') {
    throw new PtyOwnershipTransferDestinationError('input-conflict', 'input frame is malformed')
  }
  const existing = record.acceptedInputIds.get(inputId)
  if (existing !== undefined) {
    if (existing !== data) {
      throw new PtyOwnershipTransferDestinationError(
        'input-conflict',
        `input ID ${inputId} changed`
      )
    }
    return { accepted: false, duplicate: true }
  }
  if (record.acceptedInputIds.size >= state.inputIds) {
    throw new PtyOwnershipTransferDestinationError(
      'input-deduplication-window-exhausted',
      'input deduplication window is full; retire acknowledged IDs before continuing'
    )
  }
  const result = state.options.store.acceptInput(record.identity, inputId, data)
  if (result === 'conflict') {
    throw new PtyOwnershipTransferDestinationError('input-conflict', `input ID ${inputId} changed`)
  }
  record.acceptedInputIds.set(inputId, data)
  return { accepted: result === 'accepted', duplicate: result === 'duplicate' }
}

export function retireDestinationInput(
  state: DestinationAdapterState,
  inputIds: readonly string[]
): number {
  const record = requireDestinationRecord(state)
  if (record.phase !== 'committed' && record.phase !== 'published') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'input IDs can only be retired after commit'
    )
  }
  if (inputIds.some((inputId) => typeof inputId !== 'string' || inputId.length === 0)) {
    throw new PtyOwnershipTransferDestinationError('input-conflict', 'input ID is malformed')
  }
  const durableRetired = state.options.store.retireInput(record.identity, inputIds)
  for (const inputId of inputIds) {
    record.acceptedInputIds.delete(inputId)
  }
  return durableRetired
}
