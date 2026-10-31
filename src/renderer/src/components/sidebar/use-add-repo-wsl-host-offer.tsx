import { useCallback, useState, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import { AddRepoWslHostOffer } from './AddRepoWslHostOffer'
import { readWslHostOfferGate, wslHostOfferFor } from './wsl-host-offer'
import type { WslHostOffer } from './wsl-host-offer-actions'

/** Holds a local `\\wsl.localhost` add to offer its distro as a host; reads only the path (E9). */
export function useAddRepoWslHostOffer(
  isOpen: boolean,
  selectedHostId: ExecutionHostId | null
): {
  offer: (path: string, source: AddRepoExistingWorkspaceSource) => boolean
  notice: (
    addLocalPath: (path: string, source: AddRepoExistingWorkspaceSource) => Promise<unknown>
  ) => ReactNode
} {
  const [pending, setPending] = useState<WslHostOffer | null>(null)
  const [wasOpen, setWasOpen] = useState(isOpen)
  // Closing the dialog drops the offer (adjusted during render, not in an effect).
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen)
    if (!isOpen) {
      setPending(null)
    }
  }
  const offer = useCallback(
    (path: string, source: AddRepoExistingWorkspaceSource): boolean => {
      if (selectedHostId !== LOCAL_EXECUTION_HOST_ID) {
        return false
      }
      const distro = wslHostOfferFor(path, readWslHostOfferGate(useAppStore.getState()))
      if (!distro) {
        return false
      }
      setPending({ path, distro, source })
      return true
    },
    [selectedHostId]
  )
  return {
    offer,
    notice: (addLocalPath) =>
      pending && selectedHostId === LOCAL_EXECUTION_HOST_ID ? (
        <AddRepoWslHostOffer
          key={pending.path}
          offer={pending}
          onSettled={() => setPending(null)}
          addLocalPath={addLocalPath}
        />
      ) : null
  }
}
