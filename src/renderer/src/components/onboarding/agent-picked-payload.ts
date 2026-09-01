// Why: extracted as a pure helper so the renderer-end attachment guarantee
// (use-onboarding-flow reads `pathSource` / `pathFailureReason` from the
// store and forwards them on `onboarding_agent_picked`) is unit-testable
// without a React rendering harness. Without this isolation, the entire
// instrument-first plan in docs/agent-on-path-detection.md can ship dark
// for two weeks before a dashboard read shows the fields are null-only.

import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { resolveTuiAgentBaseAgent } from '../../../../shared/custom-tui-agents'
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
    // Pure builder: resolve only the built-in base here; a custom pick has no
    // static kind without the catalog and maps to 'other'.
    agent_kind: tuiAgentToAgentKind(resolveTuiAgentBaseAgent(snapshot.agent) ?? snapshot.agent),
    on_path: snapshot.detectedAgentIds.includes(snapshot.agent),
    detected_count: snapshot.detectedAgentIds.length,
    detection_state: snapshot.isDetecting ? 'pending' : 'complete',
    from_collapsed_section: snapshot.fromCollapsedSection,
    // Why: omit (not null) when refresh hasn't resolved yet so `.optional()`
    // validates cleanly under `.strict()` in the main-process schema.
    ...(snapshot.pathSource !== null ? { path_source: snapshot.pathSource } : {}),
    ...(snapshot.pathFailureReason !== null
      ? { path_failure_reason: snapshot.pathFailureReason }
      : {})
  }
}
