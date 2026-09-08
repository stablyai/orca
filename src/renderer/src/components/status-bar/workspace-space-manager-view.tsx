import type { useWorkspaceSpaceManagerPanel } from './use-workspace-space-manager-panel'
import { WorkspaceSpaceManagerOverview } from './workspace-space-manager-overview'
import { WorkspaceSpaceManagerToolbar } from './workspace-space-manager-toolbar'
import { WorkspaceSpaceManagerTable } from './workspace-space-manager-table'

type WorkspaceSpaceManagerModel = ReturnType<typeof useWorkspaceSpaceManagerPanel>

export function WorkspaceSpaceManagerView({
  model
}: {
  model: WorkspaceSpaceManagerModel
}): React.JSX.Element {
  return (
    <div className="space-y-5">
      <WorkspaceSpaceManagerOverview model={model} />
      <WorkspaceSpaceManagerToolbar model={model} />
      <WorkspaceSpaceManagerTable model={model} />
    </div>
  )
}
