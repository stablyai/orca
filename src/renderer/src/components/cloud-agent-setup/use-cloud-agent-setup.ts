import { useCallback, useEffect, useState } from 'react'
import {
  cloudSecretsErrorCode,
  type CloudSecretsErrorCode
} from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import {
  deriveCloudAgentReadiness,
  offerableDesktopKeys,
  type CloudAgentReadiness,
  type CloudOfferableDesktopKey
} from './cloud-agent-readiness'
import {
  cloudAgentSetupProblem,
  cloudAgentSetupWrite,
  type CloudAgentSetupChoice
} from './cloud-agent-setup-choices'
import type { CloudAgentSetupFailure, CloudAgentSetupScope } from './CloudAgentSetupView'

// Codes, not copy: the view turns them into words.
const UNKNOWN: CloudSecretsErrorCode = 'unknown'
const NOT_CONFIGURED: CloudSecretsErrorCode = 'not_configured'

export type CloudAgentSetupModel =
  | { status: 'loading' }
  | {
      status: 'ready'
      readiness: CloudAgentReadiness
      canShare: boolean
      /** This computer's keys that no Cloud secret covers yet: offered, never sent unasked. */
      desktopKeys: CloudOfferableDesktopKey[]
    }

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
  saveDesktopKey: (key: CloudOfferableDesktopKey) => Promise<CloudSecretsErrorCode | null>
} {
  const { repo, runtimeEnvironmentId = null, enabled = true } = args
  const [model, setModel] = useState<CloudAgentSetupModel>({ status: 'loading' })
  // Bumped after a save so the model re-reads what the cloud now has.
  const [generation, setGeneration] = useState(0)

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
        readiness: deriveCloudAgentReadiness(view?.secrets ?? []),
        canShare: view?.caller.canWrite.org === true,
        // Without the cloud's answer nothing is offered: a save could shadow a key the team set.
        desktopKeys: view ? offerableDesktopKeys(desktop?.keys ?? [], view.secrets) : []
      })
    })
    return () => {
      cancelled = true
    }
  }, [repo, enabled, generation])

  const save = useCallback(
    async (
      choice: CloudAgentSetupChoice,
      scope: CloudAgentSetupScope
    ): Promise<CloudAgentSetupFailure | null> => {
      const api = window.api.cloudSecrets
      if (!api) {
        return { error: NOT_CONFIGURED }
      }
      const write = cloudAgentSetupWrite(choice)
      const problem = cloudAgentSetupProblem(write)
      if (problem) {
        return problem
      }
      const result = await api.batch({ target: { scope }, set: write.set }).catch(() => null)
      if (!result) {
        return { error: UNKNOWN }
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

  const saveDesktopKey = useCallback(
    async (key: CloudOfferableDesktopKey): Promise<CloudSecretsErrorCode | null> => {
      const api = window.api.cloudSecrets
      if (!api?.saveDesktopKey) {
        return NOT_CONFIGURED
      }
      const result = await api
        .saveDesktopKey({ agent: key.agent, envName: key.envName })
        .catch(() => null)
      if (!result) {
        return UNKNOWN
      }
      if (!result.ok) {
        return result.error
      }
      if (runtimeEnvironmentId) {
        void api.refreshEnv({ runtimeEnvironmentId }).catch(() => undefined)
      }
      setGeneration((value) => value + 1)
      return null
    },
    [runtimeEnvironmentId]
  )

  return { model, save, saveDesktopKey }
}
