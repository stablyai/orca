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

  return (
    <>
      <AddRepoHostSelector
        hosts={hostSelection.addProjectHostOptions}
        selectedOptionId={hostSelection.selectedOptionId}
        open={hostSelection.hostSelectorOpen}
        onOpenChange={hostSelection.setHostSelectorOpen}
        onSelectHost={(optionId) => void hostSelection.handleSelectAddProjectHost(optionId)}
        onConnectHost={(optionId) => void hostSelection.handleConnectAddProjectHost(optionId)}
        onAddSshHost={() => setAddRemoteHostMode('ssh')}
        onAddRemoteServer={() => setAddRemoteHostMode('server')}
      />
      <AddRemoteHostDialog mode={addRemoteHostMode} onOpenChange={setAddRemoteHostMode} />
    </>
  )
}
