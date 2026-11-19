import { WorktreeHostContextBadge } from '@/components/sidebar/workspace-card/host/WorktreeHostContextBadge'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { useBotHostLabel } from './use-bot-host-label'

/** The paired server an `@` row's bot runs on, as the sidebar's bot row shows it. */
export function BotMentionHostBadge({
  hostId
}: {
  hostId: ExecutionHostId
}): React.JSX.Element | null {
  const label = useBotHostLabel(hostId)
  return label ? <WorktreeHostContextBadge label={label} /> : null
}
