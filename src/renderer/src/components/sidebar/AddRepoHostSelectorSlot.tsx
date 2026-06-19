import { AddRepoHostSelector } from './AddRepoHostSelector'
import type { useAddRepoHostSelection } from './use-add-repo-host-selection'

export function AddRepoHostSelectorSlot({
  hostSelection
}: {
  hostSelection: ReturnType<typeof useAddRepoHostSelection>
}) {
  return (
    <AddRepoHostSelector
      hosts={hostSelection.hostOptions}
      selectedHostId={hostSelection.selectedHostId}
      open={hostSelection.hostSelectorOpen}
      onOpenChange={hostSelection.setHostSelectorOpen}
      onSelectHost={(hostId) => void hostSelection.handleSelectAddProjectHost(hostId)}
    />
  )
}
