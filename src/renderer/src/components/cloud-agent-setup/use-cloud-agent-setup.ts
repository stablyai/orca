import { useCallback, useEffect, useState } from 'react'
import { cloudSecretsErrorCode } from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import { deriveCloudAgentReadiness, type CloudAgentReadiness } from './cloud-agent-readiness'
import {
  cloudAgentSetupProblem,
  cloudAgentSetupWrite,
  type CloudAgentSetupChoice
} from './cloud-agent-setup-choices'
import type { CloudAgentSetupFailure, CloudAgentSetupScope } from './CloudAgentSetupView'

export type CloudAgentSetupModel =
  | { status: 'loading' }
  | { status: 'ready'; readiness: CloudAgentReadiness; canShare: boolean }

/**
 * What a new cloud workspace already has for agents (desktop keys, team and cloud secrets) and how to
 * add more. A failed read counts as "nothing yet": the step then offers every option instead of hiding.
 */
export function useCloudAgentSetup(args: {
  repo: string | null
  runtimeEnvironmentId?: string | null
  enabled?: boolean
}): {
  model: CloudAgentSetupModel
  save: (
    choice: CloudAgentSetupChoice,
    scope: CloudAgentSetupScope
  ) => Promise<CloudAgentSetupFailure | null>
} {
  const { repo, runtimeEnvironmentId = null, enabled = true } = args
  const [model, setModel] = useState<CloudAgentSetupModel>({ status: 'loading' })

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    const keys = window.api.agentApiKeys?.list().catch(() => null) ?? Promise.resolve(null)
    const effective =
      window.api.cloudSecrets?.effective(repo ? { repo } : {}).catch(() => null) ??
      Promise.resolve(null)
    void Promise.all([keys, effective]).then(([desktop, cloud]) => {
      if (cancelled) {
        return
      }
      const view = cloud?.ok ? cloud.value : null
      setModel({
        status: 'ready',
        readiness: deriveCloudAgentReadiness(desktop?.keys ?? [], view?.secrets ?? []),
        canShare: view?.caller.canWrite.org === true
      })
    })
    return () => {
      cancelled = true
    }
  }, [repo, enabled])

  const save = useCallback(
    async (
      choice: CloudAgentSetupChoice,
      scope: CloudAgentSetupScope
    ): Promise<CloudAgentSetupFailure | null> => {
      const api = window.api.cloudSecrets
      if (!api) {
        return { error: 'not_configured' }
      }
      const write = cloudAgentSetupWrite(choice)
      const problem = cloudAgentSetupProblem(write)
      if (problem) {
        return problem
      }
      const result = await api.batch({ target: { scope }, set: write.set }).catch(() => null)
      if (!result) {
        return { error: 'unknown' }
      }
      if (!result.ok) {
        return { error: result.error }
      }
      const refused = result.value.errors[0]
      if (refused) {
        return {
          error: cloudSecretsErrorCode(refused.reason),
          field: write.field[refused.name]
        }
      }
      if (runtimeEnvironmentId) {
        // The control plane pushes writes to running sandboxes itself; this only shortens the wait.
        void api.refreshEnv({ runtimeEnvironmentId }).catch(() => undefined)
      }
      return null
    },
    [runtimeEnvironmentId]
  )

  return { model, save }
}
