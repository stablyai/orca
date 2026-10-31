import { useEffect, useState } from 'react'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session-option-launch'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  createStructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY } from '../../../../shared/structured-agent-session-surface-capabilities'
import {
  readAgentSessionUnavailable,
  type AgentSessionUnavailable
} from '../../../../shared/agent-session-availability'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { loadHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

const LOCAL = { kind: 'local' } as const

function roleCatalog(
  agent: string,
  saved: AgentSessionModelCatalogResult | undefined
): AgentSessionOptionCatalog | null {
  const seed = getAgentSessionOptionLaunchCatalog(agent)
  return seed && saved && saved.origin !== 'unknown' && saved.models.length > 0
    ? applyStructuredAgentSessionModelCatalog(
        createStructuredAgentSessionOptionState(agent, seed),
        seed,
        saved,
        { newLaunch: false, coherentCatalog: true }
      ).catalog
    : null
}

export function useWorkerRoleModelCatalog(
  agent: string | undefined,
  enabled = true
): {
  catalog: AgentSessionOptionCatalog | null
  refresh: () => void
  isRefreshing: boolean
  error: string | null
  unavailable: AgentSessionUnavailable | null
} {
  const settings = useAppStore((state) => state.settings)
  const [demand, setDemand] = useState<{
    agent: string
    settings: GlobalSettings | null
    request: number
  } | null>(null)
  const request =
    demand !== null && demand.agent === agent && demand.settings === settings ? demand.request : 0
  const [loaded, setLoaded] = useState<{
    agent: string
    settings: GlobalSettings | null
    catalog: AgentSessionOptionCatalog | null
    request: number
    error: string | null
    unavailable: AgentSessionUnavailable | null
  } | null>(null)
  useEffect(() => {
    let current = true
    if (!enabled || !agent || !isTuiAgent(agent)) {
      return
    }
    void ensureLocalRuntimeCapabilities()
      .then(async (capabilities) => {
        if (!current) {
          return
        }
        if (capabilities === null) {
          throw new Error('Could not read host capabilities.')
        }
        const canList =
          capabilities?.includes(AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY) === true
        const reply = canList
          ? await loadHostModelCatalogSnapshot(
              LOCAL,
              agent,
              request > 0 ? { awaitListing: true } : { savedOnly: true }
            )
          : undefined
        if (current) {
          setLoaded({
            agent,
            settings,
            request,
            catalog: canList
              ? roleCatalog(agent, reply)
              : getAgentSessionOptionLaunchCatalog(agent),
            error:
              canList &&
              request > 0 &&
              !reply?.unavailable &&
              (!reply || reply.origin === 'unknown' || reply.models.length === 0)
                ? 'Host did not return a model list.'
                : null,
            unavailable: readAgentSessionUnavailable(reply?.unavailable)
          })
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setLoaded({
            agent,
            settings,
            request,
            catalog: null,
            error: error instanceof Error ? error.message : String(error),
            unavailable: null
          })
        }
      })
    return () => {
      current = false
    }
  }, [agent, settings, enabled, request])
  const sameAccount = loaded !== null && loaded.agent === agent && loaded.settings === settings
  const matches = sameAccount && loaded.request === request
  return {
    catalog: sameAccount ? loaded.catalog : null,
    isRefreshing: enabled && !!agent && isTuiAgent(agent) && !matches,
    error: matches ? loaded.error : null,
    unavailable: matches ? loaded.unavailable : null,
    refresh: () => {
      if (enabled && agent && isTuiAgent(agent)) {
        setDemand((current) => ({ agent, settings, request: (current?.request ?? 0) + 1 }))
      }
    }
  }
}
