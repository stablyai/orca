import { useCallback, useEffect, useState } from 'react'
import type {
  AgentApiKeySaveRequest,
  AgentApiKeysMutationResult,
  AgentApiKeysState
} from '../../../../../shared/agent-api-keys/agent-api-key-catalog'
import type { PreloadApi } from '../../../../../preload/api-types'

export type AgentApiKeysApi = NonNullable<PreloadApi['agentApiKeys']>

export type AgentApiKeysModel = {
  state: AgentApiKeysState | null
  save: (request: AgentApiKeySaveRequest) => Promise<string | null>
  remove: (id: string) => Promise<string | null>
}

/** Values are sent once on save and never read back. Returns the user-facing error, or null. */
export function useAgentApiKeys(api: AgentApiKeysApi | undefined): AgentApiKeysModel {
  const [state, setState] = useState<AgentApiKeysState | null>(null)

  useEffect(() => {
    if (!api) {
      return
    }
    let cancelled = false
    void api.list().then(
      (next) => {
        if (!cancelled) {
          setState(next)
        }
      },
      () => {
        if (!cancelled) {
          setState({
            keys: [],
            protection: { available: false, reason: 'Orca could not read the saved keys.' }
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [api])

  const apply = useCallback(async (run: () => Promise<AgentApiKeysMutationResult>) => {
    try {
      const result = await run()
      setState(result.state)
      return result.ok ? null : result.error
    } catch {
      return 'Orca could not save the key.'
    }
  }, [])

  const save = useCallback(
    (request: AgentApiKeySaveRequest) =>
      api
        ? apply(() => api.save(request))
        : Promise.resolve('Keys are managed in the desktop app.'),
    [api, apply]
  )
  const remove = useCallback(
    (id: string) =>
      api ? apply(() => api.remove(id)) : Promise.resolve('Keys are managed in the desktop app.'),
    [api, apply]
  )

  return { state, save, remove }
}
