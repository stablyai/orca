import { useState } from 'react'
import { AddRepoHostSelector } from './AddRepoHostSelector'
import type { useAddRepoHostSelection } from './use-add-repo-host-selection'
import { AddRemoteHostDialog, type AddRemoteHostMode } from './AddRemoteHostDialog'
import {
  openWslHostsExperimentalSetting,
  useWslHostsAcceptNewWork,
  useWslHostsPaused
} from './use-wsl-hosts-enabled'
import { getWslHostsPausedShortLabel } from './wsl-host-row-status'

export function AddRepoHostSelectorSlot({
  hostSelection
}: {
  hostSelection: ReturnType<typeof useAddRepoHostSelection>
}) {
  const [addRemoteHostMode, setAddRemoteHostMode] = useState<AddRemoteHostMode | null>(null)
  const wslHostsAcceptNewWork = useWslHostsAcceptNewWork()
  const wslHostsPaused = useWslHostsPaused()

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
        wslHostsPausedNote={wslHostsPaused ? getWslHostsPausedShortLabel() : undefined}
        onOpenWslHostsSetting={openWslHostsExperimentalSetting}
      />
      <AddRemoteHostDialog mode={addRemoteHostMode} onOpenChange={setAddRemoteHostMode} />
    </>
  )
}
