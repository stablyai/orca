import { useCallback, useEffect, useRef, useState } from 'react'
import { useAddRepoHostSelection } from './use-add-repo-host-selection'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type AddProjectSource =
  | { kind: 'local' }
  | { kind: 'ssh'; targetId: string }
  | { kind: 'wsl' }

export function useAddRepoSourceSelection({
  isOpen,
  setStep
}: {
  isOpen: boolean
  setStep: (step: AddRepoDialogStep) => void
}): ReturnType<typeof useAddRepoHostSelection> & {
  selectedSource: AddProjectSource
  selectWslSource: () => void
} {
  const hostSelection = useAddRepoHostSelection({ isOpen, setStep })
  const [wslSelected, setWslSelected] = useState(false)
  const previousOpenRef = useRef(false)

  useEffect(() => {
    // Why: WSL has no host to focus on reopen (it isn't an ExecutionHostId), so
    // each dialog session starts opted out — chosen only by an explicit click.
    if (isOpen && !previousOpenRef.current) {
      setWslSelected(false)
    }
    previousOpenRef.current = isOpen
  }, [isOpen])

  const selectWslSource = useCallback((): void => {
    setWslSelected(true)
    setStep('wsl')
  }, [setStep])

  const handleSelectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      await hostSelection.handleSelectAddProjectHost(hostId)
      setWslSelected(false)
    },
    [hostSelection]
  )

  const handleConnectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      await hostSelection.handleConnectAddProjectHost(hostId)
      setWslSelected(false)
    },
    [hostSelection]
  )

  const selectedSource: AddProjectSource = wslSelected
    ? { kind: 'wsl' }
    : hostSelection.selectedParsedHost?.kind === 'ssh'
      ? { kind: 'ssh', targetId: hostSelection.selectedParsedHost.targetId }
      : { kind: 'local' }

  return {
    ...hostSelection,
    selectedSource,
    selectWslSource,
    handleSelectAddProjectHost,
    handleConnectAddProjectHost
  }
}
