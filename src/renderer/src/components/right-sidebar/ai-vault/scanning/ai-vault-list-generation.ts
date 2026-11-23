import { useState } from 'react'

/**
 * Identifies the list the panel is waiting for: changes when the applied list changes or a different list is
 * requested, including a return to an earlier one, so a strip hold never outlives its own wait.
 */
export function useAiVaultListGeneration(listRevision: number, listKey: string): string {
  const [keyEpoch, setKeyEpoch] = useState({ key: listKey, epoch: 0 })
  // Why: an epoch, not the key itself, so leaving a list and coming back never matches the old wait.
  const epoch = keyEpoch.key === listKey ? keyEpoch.epoch : keyEpoch.epoch + 1
  if (keyEpoch.key !== listKey) {
    setKeyEpoch({ key: listKey, epoch })
  }
  return `${listRevision}\n${epoch}`
}
