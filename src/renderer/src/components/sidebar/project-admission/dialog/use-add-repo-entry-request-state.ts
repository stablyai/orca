import { useState, type Dispatch, type SetStateAction } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WslHostWindowsDriveRefusal } from '../../../../../../shared/wsl-host-windows-drive-refusal'
import type { AddRepoDialogEntryRequest, AddRepoDialogStep } from './add-repo-dialog-types'

function stepForEntryRequest(entryRequest: AddRepoDialogEntryRequest | null): AddRepoDialogStep {
  if (entryRequest?.kind === 'clone') {
    return 'clone'
  }
  if (entryRequest?.kind === 'create') {
    return 'create'
  }
  if (entryRequest?.kind === 'browse-runtime') {
    return 'server-path'
  }
  return 'add'
}

export function useAddRepoEntryStepState(
  isOpen: boolean,
  entryRequest: AddRepoDialogEntryRequest | null
): [AddRepoDialogStep, Dispatch<SetStateAction<AddRepoDialogStep>>] {
  const activeOpenToken = isOpen ? (entryRequest?.id ?? 'open') : null
  const [lastOpenToken, setLastOpenToken] = useState<number | string | null>(activeOpenToken)
  const [step, setStep] = useState<AddRepoDialogStep>(() =>
    isOpen ? stepForEntryRequest(entryRequest) : 'add'
  )
  if (lastOpenToken !== activeOpenToken) {
    setLastOpenToken(activeOpenToken)
    if (isOpen) {
      setStep(stepForEntryRequest(entryRequest))
    }
  }
  return [step, setStep]
}

export function useApplyEntryWindowsDriveRefusal({
  isOpen,
  entryRequest,
  selectedHostId,
  showRefusal
}: {
  isOpen: boolean
  entryRequest: AddRepoDialogEntryRequest | null
  selectedHostId: ExecutionHostId | null
  showRefusal: (refusal: WslHostWindowsDriveRefusal, step?: 'add' | 'create') => void
}): void {
  const [appliedRefusalId, setAppliedRefusalId] = useState<number | null>(null)
  if (!isOpen && appliedRefusalId !== null) {
    setAppliedRefusalId(null)
  } else if (
    isOpen &&
    entryRequest?.kind === 'wsl-windows-drive-refusal' &&
    appliedRefusalId !== entryRequest.id &&
    selectedHostId === entryRequest.hostId
  ) {
    setAppliedRefusalId(entryRequest.id)
    showRefusal(entryRequest.refusal, 'add')
  }
}
