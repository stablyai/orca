import { useWorkspaceSpaceManagerPanel } from './manager/use-workspace-space-manager-panel'
import { WorkspaceSpaceManagerView } from './workspace-space-manager-view'

export function WorkspaceSpaceManagerPanel(): React.JSX.Element {
  const model = useWorkspaceSpaceManagerPanel()
  return <WorkspaceSpaceManagerView model={model} />
}
