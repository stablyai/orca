import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import { structuredAgentSessionSeedCatalog } from '../../../../../../../shared/agent-session/options/model-catalog/structured-agent-session-seed-catalog'
import type { StructuredAgentSessionOptionState } from '../../../../../../../shared/agent-session/options/structured-agent-session-options'
import { structuredAgentSessionFirstFrameOptionState } from '../../../../../../../shared/agent-session/options/view/structured-agent-session-first-frame'
import { readHostModelCatalogSnapshot } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'

/** The first frame from the host's saved list when the renderer already holds it. */
export function firstFrameOptionState(
  agent: AgentType,
  target: RuntimeClientTarget,
  launch: { newLaunch: boolean; worktree?: string; seedsModel: boolean }
): StructuredAgentSessionOptionState {
  return structuredAgentSessionFirstFrameOptionState(
    agent,
    structuredAgentSessionSeedCatalog(agent),
    readHostModelCatalogSnapshot(target, agent, launch),
    launch
  )
}
