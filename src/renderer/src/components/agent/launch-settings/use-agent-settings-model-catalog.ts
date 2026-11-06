import { useEffect, useState } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { sourceControlActionAgentPicksModel } from '../../../../../shared/source-control/ai/recipes/source-control-action-options'
import {
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot
} from '@/runtime/host-model-catalog-snapshots'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'

const SETTINGS_LAUNCH = { newLaunch: true, seedsModel: true }

/** The host's listed models for a Settings default; undefined keeps the release's seed list. */
export function useAgentSettingsModelCatalog(
  agent: TuiAgent,
  target: RuntimeClientTarget | null
): AgentSessionModelCatalogResult | undefined {
  const key = target ? `${structuredAgentSessionHostKey(target)}\u0000${agent}` : null
  const [answer, setAnswer] = useState<{
    key: string
    catalog: AgentSessionModelCatalogResult
  } | null>(null)
  useEffect(() => {
    if (!target || !key || !sourceControlActionAgentPicksModel(agent)) {
      return
    }
    let stale = false
    void callStructuredAgentSession<AgentSessionModelCatalogResult>(
      target,
      'agentSession.modelCatalog',
      { agent, waitForListing: true }
    )
      .then((catalog) => {
        if (!stale) {
          recordHostModelCatalogSnapshot(target, agent, null, catalog)
          setAnswer({ key, catalog })
        }
      })
      // A failed read proves nothing about the host's models, so the seed list stays.
      .catch(() => {})
    return () => {
      stale = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` is the target's identity.
  }, [agent, key])
  if (answer?.key === key) {
    return answer.catalog
  }
  return target ? readHostModelCatalogSnapshot(target, agent, SETTINGS_LAUNCH) : undefined
}
