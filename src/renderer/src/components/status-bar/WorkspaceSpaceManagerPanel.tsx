import { useWorkspaceSpaceManagerPanel } from './use-workspace-space-manager-panel'
import { WorkspaceSpaceManagerView } from './workspace-space-manager-view'

export { getWorkspaceDecisionDetails } from './workspace-space-decision-details'

export function WorkspaceSpaceManagerPanel(): React.JSX.Element {
  const model = useWorkspaceSpaceManagerPanel()
  return <WorkspaceSpaceManagerView model={model} />
}
