import type { AgentSessionModelCatalogResult } from '../agent-session-wire'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'

/** A chat's first frame: the host's held list when the client has one, else the seed, which shows
 *  the quiet placeholder until the host answers. */
export function structuredAgentSessionFirstFrameOptionState(
  agent: string,
  seed: AgentSessionOptionCatalog | null,
  held: AgentSessionModelCatalogResult | undefined,
  options: { newLaunch: boolean; coherentCatalog?: boolean }
): StructuredAgentSessionOptionState {
  const seeded = createStructuredAgentSessionOptionState(agent, seed)
  return held && seed
    ? applyStructuredAgentSessionModelCatalog(seeded, seed, held, options)
    : seeded
}
