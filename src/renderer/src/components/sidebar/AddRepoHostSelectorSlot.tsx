import { useState } from 'react'
import { AddRepoHostSelector } from './AddRepoHostSelector'
import type { useAddRepoHostSelection } from './use-add-repo-host-selection'
import { AddRemoteHostDialog, type AddRemoteHostMode } from './AddRemoteHostDialog'

export function AddRepoHostSelectorSlot({
  hostSelection
}: {
  hostSelection: ReturnType<typeof useAddRepoHostSelection>
}) {
  const [addRemoteHostMode, setAddRemoteHostMode] = useState<AddRemoteHostMode | null>(null)
  const selectedRuntimeEnvironment =
    hostSelection.selectedParsedHost?.kind === 'runtime'
      ? {
          id: hostSelection.selectedParsedHost.environmentId,
          label:
            hostSelection.hostOptions.find((host) => host.id === hostSelection.selectedHostId)
              ?.label ?? hostSelection.selectedParsedHost.environmentId
        }
      : null

  return (
    <>
      <AddRepoHostSelector
        hosts={hostSelection.hostOptions}
        selectedHostId={hostSelection.selectedHostId}
        open={hostSelection.hostSelectorOpen}
        onOpenChange={hostSelection.setHostSelectorOpen}
        onSelectHost={(hostId) => void hostSelection.handleSelectAddProjectHost(hostId)}
        onConnectHost={(hostId) => void hostSelection.handleConnectAddProjectHost(hostId)}
        onAddSshHost={() => setAddRemoteHostMode('ssh')}
        onAddRemoteServer={() => setAddRemoteHostMode('server')}
      />
      <AddRemoteHostDialog
        mode={addRemoteHostMode}
        onOpenChange={setAddRemoteHostMode}
        sshOwnerEnvironment={selectedRuntimeEnvironment}
      />
    </>
  )
}
