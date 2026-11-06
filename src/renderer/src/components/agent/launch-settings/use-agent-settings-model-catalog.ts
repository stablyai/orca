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

/** The host's listed models for a Settings default. `usesSeedModels` says the release's list stands in. */
export function useAgentSettingsModelCatalog(
  agent: TuiAgent,
  target: RuntimeClientTarget | null
): { catalog: AgentSessionModelCatalogResult | undefined; usesSeedModels: boolean } {
  const key = target ? `${structuredAgentSessionHostKey(target)}\u0000${agent}` : null
  const [settledKey, setSettledKey] = useState<string | null>(null)
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
        }
      })
      // A failed read proves nothing about the host's models, so the seed list stays.
      .catch(() => {})
      .finally(() => {
        if (!stale) {
          setSettledKey(key)
        }
      })
    return () => {
      stale = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` is the target's identity.
  }, [agent, key])
  // Why the snapshot: it drops a listed default that a workspace's own config could replace.
  const catalog = target ? readHostModelCatalogSnapshot(target, agent, SETTINGS_LAUNCH) : undefined
  return { catalog, usesSeedModels: !catalog && (!target || settledKey === key) }
}
