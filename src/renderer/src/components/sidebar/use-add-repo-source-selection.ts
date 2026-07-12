import { useCallback, useEffect, useRef, useState } from 'react'
import { useAddRepoHostSelection } from './use-add-repo-host-selection'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type AddProjectSource =
  | { kind: 'local' }
  | { kind: 'ssh'; targetId: string }
  | { kind: 'wsl' }

/**
 * Tracks which add-project source (local/SSH host vs. WSL) is selected in the
 * add-repo dialog. WSL isn't an `ExecutionHostId`, so it's tracked as separate
 * boolean state layered on top of {@link useAddRepoHostSelection}.
 */
export function useAddRepoSourceSelection({
  isOpen,
  setStep,
  resetWslFlow
}: {
  isOpen: boolean
  setStep: (step: AddRepoDialogStep) => void
  resetWslFlow: () => void
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

  // Why: host-scoped resets only fire when selectedHostId changes, so re-selecting
  // the same host (or leaving WSL for a host) must clear the WSL distro/path/error
  // here too — otherwise a later WSL visit starts with stale field state.
  const handleSelectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      await hostSelection.handleSelectAddProjectHost(hostId)
      setWslSelected(false)
      resetWslFlow()
    },
    [hostSelection, resetWslFlow]
  )

  const handleConnectAddProjectHost = useCallback(
    async (hostId: ExecutionHostId): Promise<void> => {
      await hostSelection.handleConnectAddProjectHost(hostId)
      setWslSelected(false)
      resetWslFlow()
    },
    [hostSelection, resetWslFlow]
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
