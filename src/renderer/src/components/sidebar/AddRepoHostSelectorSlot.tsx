import { useState } from 'react'
import { AddRepoHostSelector } from './AddRepoHostSelector'
import type { useAddRepoHostSelection } from './use-add-repo-host-selection'
import { AddRemoteHostDialog, type AddRemoteHostMode } from './AddRemoteHostDialog'
import { openWslHostsExperimentalSetting, useWslHostsAcceptNewWork } from './use-wsl-hosts-enabled'

export function AddRepoHostSelectorSlot({
  hostSelection
}: {
  hostSelection: ReturnType<typeof useAddRepoHostSelection>
}) {
  const [addRemoteHostMode, setAddRemoteHostMode] = useState<AddRemoteHostMode | null>(null)
  const wslHostsAcceptNewWork = useWslHostsAcceptNewWork()

  return (
    <>
      <AddRepoHostSelector
        hosts={hostSelection.hostOptions}
        selectedHostId={hostSelection.displayedHostId}
        open={hostSelection.hostSelectorOpen}
        onOpenChange={hostSelection.setHostSelectorOpen}
        onSelectHost={(hostId) => void hostSelection.handleSelectAddProjectHost(hostId)}
        onConnectHost={(hostId) => void hostSelection.handleConnectAddProjectHost(hostId)}
        onAddSshHost={() => setAddRemoteHostMode('ssh')}
        onAddRemoteServer={() => setAddRemoteHostMode('server')}
        onAddWslHost={wslHostsAcceptNewWork ? () => setAddRemoteHostMode('wsl') : undefined}
        onOpenWslHostsSetting={openWslHostsExperimentalSetting}
      />
      <AddRemoteHostDialog mode={addRemoteHostMode} onOpenChange={setAddRemoteHostMode} />
    </>
  )
}
