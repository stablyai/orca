import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '@/store/index'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { AddRepoExistingWorkspaceSource } from '../../../../../../shared/telemetry/schemas/telemetry-property-schemas'
import { AddRepoWslHostOffer } from './AddRepoWslHostOffer'
import { AddRepoExistingWslHostOffer } from './AddRepoExistingWslHostOffer'
import type { DroppedHostPath } from './add-repo-wsl-host-folder-picker'
import {
  existingWslHostOfferFor,
  readExistingWslHosts,
  readWslHostOfferGate,
  shouldOfferWslHost,
  wslHostOfferFor,
  type ExistingWslHostOffer
} from './wsl-host-offer'
import type { WslHostOffer } from './wsl-host-offer-actions'
import { resolveWslMappedDrivePath } from './wsl-mapped-drive-path'
import { wslHostOfferProjectRef } from '../../../wsl-move/wsl-host-offer-move'

type PendingOffer =
  | ({ kind: 'run-host' } & WslHostOffer)
  | ({
      kind: 'existing-host'
      path: string
      source: AddRepoExistingWorkspaceSource
    } & ExistingWslHostOffer)

/** Holds a local `\\wsl.localhost` (or distro-mapped drive) add to offer its distro as a host (E9). */
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
    handleConnectAddProjectHost: (hostId: ExecutionHostId) => Promise<boolean>
  },
  droppedHostPath: DroppedHostPath | null
): {
  /** `isCurrent` is false once the add it answers for was closed or superseded. */
  offer: (
    path: string,
    source: AddRepoExistingWorkspaceSource,
    isCurrent?: () => boolean
  ) => Promise<boolean>
  notice: (
    addLocalPath: (path: string, source: AddRepoExistingWorkspaceSource) => Promise<unknown>
  ) => ReactNode
  /** The newest of "Add on host" and a drop onto a host, prefilled once that host is selected. */
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
  // A later drop supersedes an earlier "Add on host" choice.
  const [seenDrop, setSeenDrop] = useState(droppedHostPath)
  if (seenDrop !== droppedHostPath) {
    setSeenDrop(droppedHostPath)
    setHostPath(null)
  }
  // Each offer, close, reopen and host change starts a new request; only the newest may show.
  const requestRef = useRef(0)
  useEffect(() => {
    requestRef.current += 1
  }, [isOpen, selectedHostId])
  const offer = useCallback(
    async (
      path: string,
      source: AddRepoExistingWorkspaceSource,
      isCurrent: () => boolean = () => true
    ): Promise<boolean> => {
      const request = ++requestRef.current
      if (selectedHostId !== LOCAL_EXECUTION_HOST_ID) {
        return false
      }
      const before = useAppStore.getState()
      const hosts = readExistingWslHosts(before)
      // Only a path an offer could take asks main; ordinary adds never wait on it.
      const mightOffer = hosts.length > 0 || shouldOfferWslHost(readWslHostOfferGate(before))
      const sharePath = mightOffer ? await resolveWslMappedDrivePath(path) : null
      if (request !== requestRef.current || !isCurrent()) {
        // Closed, re-hosted or superseded while main resolved the drive: nothing to offer or add.
        return true
      }
      // Already saved at its drive spelling: the add finds that project, never a second copy.
      if (sharePath && wslHostOfferProjectRef(path)) {
        return false
      }
      const offerPath = sharePath ?? path
      const state = sharePath ? useAppStore.getState() : before
      // A distro that already runs as a host offers that host, not a second one.
      const existing = existingWslHostOfferFor(
        offerPath,
        sharePath ? readExistingWslHosts(state) : hosts
      )
      if (existing) {
        setPending({ kind: 'existing-host', path, source, ...existing })
        return true
      }
      const distro = wslHostOfferFor(offerPath, readWslHostOfferGate(state))
      if (!distro) {
        return false
      }
      // Accepting adds the share spelling, the one a move onto the host can take.
      setPending({ kind: 'run-host', path, distro, source, ...(sharePath ? { sharePath } : {}) })
      return true
    },
    [selectedHostId]
  )
  const addOnHost = useCallback(
    async (target: ExistingWslHostOffer): Promise<void> => {
      setHostPath({ hostId: target.hostId, path: target.linuxPath })
      if ((await selectHost(target.hostId)) || (await connectHost(target.hostId))) {
        setPending(null)
        return
      }
      // Keep the offer so the user can retry or add it on this computer instead.
      setHostPath(null)
    },
    [connectHost, selectHost]
  )
  return {
    offer,
    hostPath: hostPath ?? droppedHostPath,
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
