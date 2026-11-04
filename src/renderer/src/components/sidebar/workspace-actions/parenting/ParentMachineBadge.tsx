import { useAppStore } from '@/store'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { WorktreeHostContextBadge } from '../../workspace-card/host/WorktreeHostContextBadge'

/** Names the machine of a parent candidate on another machine, as the sidebar badge does. */
export function ParentMachineBadge({ hostId }: { hostId: ExecutionHostId }): React.JSX.Element {
  const label = useAppStore((state) => selectExecutionHostDisplayLabel(state, hostId))
  return <WorktreeHostContextBadge label={label} />
}
