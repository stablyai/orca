import { useCallback, useState, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import { AddRepoWslHostOffer } from './AddRepoWslHostOffer'
import { AddRepoExistingWslHostOffer } from './AddRepoExistingWslHostOffer'
import type { DroppedHostPath } from './add-repo-wsl-host-folder-picker'
import {
  existingWslHostOfferFor,
  readExistingWslHosts,
  readWslHostOfferGate,
  wslHostOfferFor,
  type ExistingWslHostOffer
} from './wsl-host-offer'
import type { WslHostOffer } from './wsl-host-offer-actions'

type PendingOffer =
  | ({ kind: 'run-host' } & WslHostOffer)
  | ({
      kind: 'existing-host'
      path: string
      source: AddRepoExistingWorkspaceSource
    } & ExistingWslHostOffer)

/** Holds a local `\\wsl.localhost` add to offer its distro as a host; reads only the path (E9). */
export function useAddRepoWslHostOffer(
  isOpen: boolean,
  {
    selectedHostId,
    handleSelectAddProjectHost: selectHost,
    // Starts a host that is not selectable yet; the user's click is what may start its distro.
    handleConnectAddProjectHost: connectHost
  }: {
    selectedHostId: ExecutionHostId | null
    handleSelectAddProjectHost: (hostId: ExecutionHostId) => Promise<boolean>
    handleConnectAddProjectHost: (hostId: ExecutionHostId) => Promise<void>
  }
): {
  offer: (path: string, source: AddRepoExistingWorkspaceSource) => boolean
  notice: (
    addLocalPath: (path: string, source: AddRepoExistingWorkspaceSource) => Promise<unknown>
  ) => ReactNode
  /** The host path the user chose to add on an existing host, prefilled once that host is selected. */
  hostPath: DroppedHostPath | null
} {
  const [pending, setPending] = useState<PendingOffer | null>(null)
  const [hostPath, setHostPath] = useState<DroppedHostPath | null>(null)
  const [wasOpen, setWasOpen] = useState(isOpen)
  // Closing the dialog drops the offer (adjusted during render, not in an effect).
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen)
    if (!isOpen) {
      setPending(null)
      setHostPath(null)
    }
  }
  const offer = useCallback(
    (path: string, source: AddRepoExistingWorkspaceSource): boolean => {
      if (selectedHostId !== LOCAL_EXECUTION_HOST_ID) {
        return false
      }
      const state = useAppStore.getState()
      // A distro that already runs as a host offers that host, not a second one.
      const existing = existingWslHostOfferFor(path, readExistingWslHosts(state))
      if (existing) {
        setPending({ kind: 'existing-host', path, source, ...existing })
        return true
      }
      const distro = wslHostOfferFor(path, readWslHostOfferGate(state))
      if (!distro) {
        return false
      }
      setPending({ kind: 'run-host', path, distro, source })
      return true
    },
    [selectedHostId]
  )
  const addOnHost = useCallback(
    async (target: ExistingWslHostOffer): Promise<void> => {
      setHostPath({ hostId: target.hostId, path: target.linuxPath })
      if (!(await selectHost(target.hostId))) {
        await connectHost(target.hostId)
      }
      setPending(null)
    },
    [connectHost, selectHost]
  )
  return {
    offer,
    hostPath,
    notice: (addLocalPath) => {
      if (!pending || selectedHostId !== LOCAL_EXECUTION_HOST_ID) {
        return null
      }
      const onSettled = (): void => setPending(null)
      return pending.kind === 'existing-host' ? (
        <AddRepoExistingWslHostOffer
          key={pending.path}
          distro={pending.distro}
          onAddOnHost={() => addOnHost(pending)}
          onAddOnThisComputer={() => {
            onSettled()
            void addLocalPath(pending.path, pending.source)
          }}
        />
      ) : (
        <AddRepoWslHostOffer
          key={pending.path}
          offer={pending}
          onSettled={onSettled}
          addLocalPath={addLocalPath}
        />
      )
    }
  }
}
