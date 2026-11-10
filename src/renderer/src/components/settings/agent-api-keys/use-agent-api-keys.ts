import { useCallback, useEffect, useState } from 'react'
import type {
  AgentApiKeySaveRequest,
  AgentApiKeysMutationResult,
  AgentApiKeysState
} from '../../../../../shared/agent-api-keys/agent-api-key-catalog'
import type {
  AgentApiKeyCloudOutcome,
  AgentApiKeysImportResult,
  AgentApiKeysScanResult
} from '../../../../../shared/agent-api-keys/agent-api-key-cloud'
import type { CloudSecretsErrorCode } from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import type { PreloadApi } from '../../../../../preload/api-types'

export type AgentApiKeysApi = NonNullable<PreloadApi['agentApiKeys']>

export type AgentApiKeysModel = {
  state: AgentApiKeysState | null
  save: (request: AgentApiKeySaveRequest) => Promise<string | null>
  /** `fromAccount` also deletes the copy this computer saved to the Orca account. */
  remove: (id: string, fromAccount?: boolean) => Promise<string | null>
  /** Why the last write of a key to the Orca account failed, by key id. */
  cloudFailures?: Readonly<Record<string, CloudSecretsErrorCode>>
  saveToAccount?: (id: string) => Promise<CloudSecretsErrorCode | null>
  scanThisComputer?: () => Promise<AgentApiKeysScanResult>
  importFromThisComputer?: (names: string[]) => Promise<AgentApiKeysImportResult | null>
}

const DESKTOP_ONLY = 'Keys are managed in the desktop app.'

/** Values are sent once on save and never read back. Returns the user-facing error, or null. */
export function useAgentApiKeys(api: AgentApiKeysApi | undefined): AgentApiKeysModel {
  const [state, setState] = useState<AgentApiKeysState | null>(null)
  const [cloudFailures, setCloudFailures] = useState<Record<string, CloudSecretsErrorCode>>({})

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
            protection: {
              available: false,
              reason: 'Orca could not read the saved keys.'
            }
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [api])

  const noteCloud = useCallback((outcome: AgentApiKeyCloudOutcome | undefined) => {
    if (outcome?.kind === 'failed' && outcome.keyId) {
      const { keyId, error } = outcome
      setCloudFailures((current) => ({ ...current, [keyId]: error }))
    }
  }, [])

  const apply = useCallback(
    async (
      run: () => Promise<AgentApiKeysMutationResult>,
      clearFailureFor?: string
    ): Promise<AgentApiKeysMutationResult | null> => {
      try {
        const result = await run()
        setState(result.state)
        if (clearFailureFor) {
          setCloudFailures(({ [clearFailureFor]: _cleared, ...rest }) => rest)
        }
        noteCloud(result.cloud)
        return result
      } catch {
        return null
      }
    },
    [noteCloud]
  )

  const save = useCallback(
    async (request: AgentApiKeySaveRequest) => {
      if (!api) {
        return DESKTOP_ONLY
      }
      const result = await apply(() => api.save(request), request.id)
      return !result ? 'Orca could not save the key.' : result.ok ? null : result.error
    },
    [api, apply]
  )
  const remove = useCallback(
    async (id: string, fromAccount = false) => {
      if (!api) {
        return DESKTOP_ONLY
      }
      const result = await apply(() => api.remove(fromAccount ? { id, fromAccount } : id))
      if (!result) {
        return 'Orca could not remove the key.'
      }
      if (result.ok && result.cloud?.kind === 'failed') {
        return 'Couldn’t remove it from your Orca account. Nothing was changed.'
      }
      return result.ok ? null : result.error
    },
    [api, apply]
  )
  const saveToAccount = useCallback(
    async (id: string): Promise<CloudSecretsErrorCode | null> => {
      if (!api?.saveToAccount) {
        return 'not_configured'
      }
      const saveToAccountApi = api.saveToAccount
      const result = await apply(() => saveToAccountApi(id), id)
      if (!result) {
        return 'unknown'
      }
      return result.cloud?.kind === 'failed' ? result.cloud.error : null
    },
    [api, apply]
  )
  const scanThisComputer = useCallback(async (): Promise<AgentApiKeysScanResult> => {
    if (!api?.scanThisComputer) {
      return { keys: [], signIns: [] }
    }
    return api.scanThisComputer()
  }, [api])
  const importFromThisComputer = useCallback(
    async (names: string[]): Promise<AgentApiKeysImportResult | null> => {
      if (!api?.importFromThisComputer) {
        return null
      }
      try {
        const result = await api.importFromThisComputer(names)
        setState(result.state)
        return result
      } catch {
        return null
      }
    },
    [api]
  )

  return {
    state,
    save,
    remove,
    cloudFailures,
    saveToAccount,
    scanThisComputer: api?.scanThisComputer ? scanThisComputer : undefined,
    importFromThisComputer
  }
}
