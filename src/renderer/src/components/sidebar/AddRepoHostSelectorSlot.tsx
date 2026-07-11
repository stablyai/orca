import { useState } from 'react'
import { AddRepoHostSelector } from './AddRepoHostSelector'
import type { useAddRepoSourceSelection } from './use-add-repo-source-selection'
import { AddRemoteHostDialog, type AddRemoteHostMode } from './AddRemoteHostDialog'

export function AddRepoHostSelectorSlot({
  hostSelection
}: {
  hostSelection: ReturnType<typeof useAddRepoSourceSelection>
}) {
  const [addRemoteHostMode, setAddRemoteHostMode] = useState<AddRemoteHostMode | null>(null)

  return (
    <>
      <AddRepoHostSelector
        hosts={hostSelection.hostOptions}
        selectedHostId={hostSelection.selectedHostId}
        selectedSource={hostSelection.selectedSource}
        open={hostSelection.hostSelectorOpen}
        onOpenChange={hostSelection.setHostSelectorOpen}
        onSelectHost={(hostId) => void hostSelection.handleSelectAddProjectHost(hostId)}
        onConnectHost={(hostId) => void hostSelection.handleConnectAddProjectHost(hostId)}
        onSelectWsl={hostSelection.selectWslSource}
        onAddSshHost={() => setAddRemoteHostMode('ssh')}
        onAddRemoteServer={() => setAddRemoteHostMode('server')}
      />
      <AddRemoteHostDialog mode={addRemoteHostMode} onOpenChange={setAddRemoteHostMode} />
    </>
  )
}
