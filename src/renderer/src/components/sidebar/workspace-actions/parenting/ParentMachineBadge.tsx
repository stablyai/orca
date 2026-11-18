import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { WorktreeHostContextBadge } from '../../workspace-card/host/WorktreeHostContextBadge'
import { useAppStoreWithChannels } from '@/store/channels/use-app-store-with-channels'

/** Names the machine of a parent candidate on another machine, as the sidebar badge does. */
export function ParentMachineBadge({ hostId }: { hostId: ExecutionHostId }): React.JSX.Element {
  const label = useAppStoreWithChannels((state) => selectExecutionHostDisplayLabel(state, hostId))
  return <WorktreeHostContextBadge label={label} />
}
