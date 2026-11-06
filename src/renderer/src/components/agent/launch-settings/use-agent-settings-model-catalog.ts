import { useEffect, useState } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { withoutUnprovenNewLaunchDefault } from '../../../../../shared/agent-session/options/host-model-catalog-snapshot-rules'
import { sourceControlActionAgentPicksModel } from '../../../../../shared/source-control/ai/recipes/source-control-action-options'
import {
  readHostModelCatalogSnapshot,
  recordHostModelCatalogSnapshot
} from '@/runtime/host-model-catalog-snapshots'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'

const SETTINGS_LAUNCH = { newLaunch: true, seedsModel: true }

/** The host's account models for a Settings default. `usesSeedModels` says the release's list stands in. */
export function useAgentSettingsModelCatalog(
  agent: TuiAgent,
  target: RuntimeClientTarget | null
): { catalog: AgentSessionModelCatalogResult | undefined; usesSeedModels: boolean } {
  const key = target ? `${structuredAgentSessionHostKey(target)}\u0000${agent}` : null
  const [answer, setAnswer] = useState<{
    key: string
    catalog: AgentSessionModelCatalogResult | undefined
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
      // Why not the snapshot: an unanswered read can't vouch for an older list.
      .catch(() => {
        if (!stale) {
          setAnswer({ key, catalog: undefined })
        }
      })
    return () => {
      stale = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `key` is the target's identity.
  }, [agent, key])
  const settled = answer?.key === key ? answer : null
  // Why not the snapshot once answered: it serves new chats, so it refuses workspace-scoped lists.
  const catalog = settled
    ? settled.catalog && withoutUnprovenNewLaunchDefault(settled.catalog)
    : target
      ? readHostModelCatalogSnapshot(target, agent, SETTINGS_LAUNCH)
      : undefined
  const listed = catalog && catalog.origin !== 'unknown' && catalog.models.length > 0
  return { catalog, usesSeedModels: !listed && (!target || settled !== null) }
}
