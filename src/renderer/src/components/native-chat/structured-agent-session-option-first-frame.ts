import { cloneStructuredAgentSessionOptionRecord } from '../../../../shared/agent-session/options/structured-agent-session-option-state'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/agent-session/options/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  type StructuredAgentSessionOptionState
} from '../../../../shared/agent-session/options/structured-agent-session-options'
import { readHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'

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

export function restartedOptionState(
  agent: AgentType,
  launch: {
    target: RuntimeClientTarget
    newLaunch: boolean
    worktree?: string
    seedsModel: boolean
  },
  previous: StructuredAgentSessionOptionState,
  sameSession: boolean
): StructuredAgentSessionOptionState {
  const seeded = firstFrameOptionState(agent, launch.target, launch)
  // Retain saved picks/account listings across same-session restarts until the starting provider can be read.
  const kept =
    sameSession &&
    (previous.optionsAnswerPresent ||
      (previous.catalogSource !== 'seed' && previous.catalogSource !== null))
      ? {
          ...previous,
          record: cloneStructuredAgentSessionOptionRecord(previous.record),
          pendingId: null,
          reportedPermissionMode: undefined,
          reportedEffort: undefined
        }
      : seeded
  return sameSession
    ? { ...kept, defaultModel: undefined, permissionMode: previous.permissionMode }
    : kept
}
