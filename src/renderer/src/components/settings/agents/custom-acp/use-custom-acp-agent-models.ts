// The models a saved custom ACP agent reported, read from this machine's catalog; Refresh lists again.

import { useCallback, useEffect, useState } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionModelOption } from '../../../../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import type { CustomAcpAgentId } from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import type { AgentSessionUnavailable } from '../../../../../../shared/agent-session/failures/agent-session-availability'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'

const LOCAL = { kind: 'local' } as const
// Each wait is bounded by the host; a slow agent gets a few before Settings gives up.
const MAX_WAITS = 4

export type CustomAcpAgentModels = {
  models: readonly AgentSessionModelOption[]
  state: 'idle' | 'listing' | 'failed'
  /** Why the last listing found no chat can start, when the host could tell. */
  problem?: AgentSessionUnavailable['reason']
  refresh: () => void
}

function listedModels(catalog: AgentSessionModelCatalogResult): AgentSessionModelOption[] {
  return catalog.origin === 'unknown' ? [] : catalog.models
}

/** `agent` is undefined for an agent not saved yet, which the host cannot list. */
export function useCustomAcpAgentModels(agent: CustomAcpAgentId | undefined): CustomAcpAgentModels {
  const [models, setModels] = useState<readonly AgentSessionModelOption[]>([])
  const [state, setState] = useState<CustomAcpAgentModels['state']>('idle')
  const [problem, setProblem] = useState<CustomAcpAgentModels['problem']>(undefined)
  // Opening Settings reads what the host already knows and never starts the agent.
  useEffect(() => {
    if (!agent) {
      return
    }
    let stale = false
    void callStructuredAgentSession<AgentSessionModelCatalogResult>(
      LOCAL,
      'agentSession.modelCatalog',
      { agent, savedOnly: true }
    )
      .then((catalog) => {
        if (!stale) {
          setModels(listedModels(catalog))
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [agent])
  const refresh = useCallback(() => {
    if (!agent) {
      return
    }
    setState('listing')
    setProblem(undefined)
    const read = async (): Promise<AgentSessionModelCatalogResult> => {
      let catalog = await callStructuredAgentSession<AgentSessionModelCatalogResult>(
        LOCAL,
        'agentSession.modelCatalog',
        { agent, relist: true }
      )
      for (let wait = 0; wait < MAX_WAITS && catalog.listingInProgress; wait += 1) {
        catalog = await callStructuredAgentSession<AgentSessionModelCatalogResult>(
          LOCAL,
          'agentSession.modelCatalog',
          { agent, waitForListing: true }
        )
      }
      return catalog
    }
    void read()
      .then((catalog) => {
        const listed = listedModels(catalog)
        setModels(listed)
        setProblem(catalog.unavailable?.reason)
        setState(listed.length > 0 && !catalog.listingInProgress ? 'idle' : 'failed')
      })
      .catch(() => setState('failed'))
  }, [agent])
  return { models, state, ...(problem ? { problem } : {}), refresh }
}
