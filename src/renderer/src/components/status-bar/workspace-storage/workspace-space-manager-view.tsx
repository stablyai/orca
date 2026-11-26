import type { useWorkspaceSpaceManagerPanel } from './manager/use-workspace-space-manager-panel'
import { WorkspaceSpaceManagerOverview } from './overview/workspace-space-manager-overview'
import { WorkspaceSpaceManagerToolbar } from './workspace-space-manager-toolbar'
import { WorkspaceSpaceManagerTable } from './table/workspace-space-manager-table'

type WorkspaceSpaceManagerModel = ReturnType<typeof useWorkspaceSpaceManagerPanel>

export function WorkspaceSpaceManagerView({
  model
}: {
  model: WorkspaceSpaceManagerModel
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <WorkspaceSpaceManagerOverview model={model} />
      <WorkspaceSpaceManagerToolbar model={model} />
      <WorkspaceSpaceManagerTable model={model} />
    </div>
  )
}
