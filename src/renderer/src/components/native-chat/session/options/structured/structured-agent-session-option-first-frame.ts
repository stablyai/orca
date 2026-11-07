import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import { structuredAgentSessionSeedCatalog } from '../../../../../../../shared/agent-session/options/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  type StructuredAgentSessionOptionState
} from '../../../../../../../shared/agent-session/options/structured-agent-session-options'
import { readHostModelCatalogSnapshot } from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'

/** The first frame: the host's saved list when the renderer already holds it, else the seed,
 *  which shows the quiet placeholder until the host answers. */
export function firstFrameOptionState(
  agent: AgentType,
  target: RuntimeClientTarget,
  launch: { newLaunch: boolean; worktree?: string; seedsModel: boolean }
): StructuredAgentSessionOptionState {
  const seed = structuredAgentSessionSeedCatalog(agent)
  const seeded = createStructuredAgentSessionOptionState(agent, seed)
  const snapshot = readHostModelCatalogSnapshot(target, agent, launch)
  return snapshot ? applyStructuredAgentSessionModelCatalog(seeded, seed, snapshot, launch) : seeded
}
