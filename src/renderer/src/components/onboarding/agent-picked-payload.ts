import { tuiAgentToAgentKind } from '@/lib/telemetry'
import type { EventProps } from '../../../../shared/telemetry-events'
import type {
  PathSource,
  ShellHydrationFailureReason
} from '../../../../shared/shell-path-hydration-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type AgentPickedSnapshot = {
  agent: TuiAgent
  detectedAgentIds: readonly TuiAgent[]
  isDetecting: boolean
  fromCollapsedSection: boolean
  pathSource: PathSource | null
  pathFailureReason: ShellHydrationFailureReason | null
}

export function buildAgentPickedPayload(
  snapshot: AgentPickedSnapshot
): EventProps<'onboarding_agent_picked'> {
  return {
    agent_kind: tuiAgentToAgentKind(snapshot.agent),
    on_path: snapshot.detectedAgentIds.includes(snapshot.agent),
    detected_count: snapshot.detectedAgentIds.length,
    detection_state: snapshot.isDetecting ? 'pending' : 'complete',
    from_collapsed_section: snapshot.fromCollapsedSection,
    // Strict optional fields require omission rather than unresolved null values.
    ...(snapshot.pathSource !== null ? { path_source: snapshot.pathSource } : {}),
    ...(snapshot.pathFailureReason !== null
      ? { path_failure_reason: snapshot.pathFailureReason }
      : {})
  }
}
