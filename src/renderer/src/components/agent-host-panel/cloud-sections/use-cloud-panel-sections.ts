// Data for the Orca Cloud panel's sections 2–3. Both reads go to the control plane (effective Cloud
// secrets and the org environment list), never to the sandbox, so an asleep sandbox stays asleep.
import { useCallback, useEffect, useState } from 'react'
import type {
  CloudSecretScope,
  CloudSecretsEffective,
  CloudSecretsErrorCode,
  CloudWorkspaceSharing
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { withoutCallerPersonal } from './cloud-panel-sections-model'
import {
  environmentForRepo,
  missingSecretNames
} from '../../cloud-secrets-ask/cloud-secrets-ask-model'

export type CloudPanelSectionsData = {
  effective: CloudSecretsEffective
  /** The environment's declared names nobody provides (empty without an environment). */
  missing: string[]
  /** `github.com/owner/name`, for Repository writes; null when the workspace repo isn't on GitHub. */
  repoKey: string | null
  /** Asleep: show what the control plane knows and say changes land on wake. Never wake to check. */
  asleep: boolean
  /** Shared with teammates (D13), and whose workspace it is; null when unknown. */
  sharing: CloudWorkspaceSharing | null
  /**
   * Personal values are left out: a shared workspace gets nobody's Personal secrets, not even its
   * owner's (SEC-5), and one whose sharing couldn't be read fails closed the same way (D13).
   */
  withoutPersonal: boolean
}

export function cloudPanelSectionsData(args: {
  effective: CloudSecretsEffective
  envVarNames: readonly string[] | null
  repoKey: string | null
  asleep: boolean
  sharing: CloudWorkspaceSharing | null
  /** The workspace's sharing read failed; treat it as possibly someone else's shared workspace. */
  sharingUnknown?: boolean
}): CloudPanelSectionsData {
  const withoutPersonal = args.sharingUnknown === true || args.sharing?.shared === true
  const effective = withoutPersonal ? withoutCallerPersonal(args.effective) : args.effective
  return {
    withoutPersonal,
    effective,
    missing: args.envVarNames ? missingSecretNames(args.envVarNames, effective) : [],
    repoKey: args.repoKey,
    asleep: args.asleep,
    sharing: args.sharing
  }
}

const NOT_CONFIGURED: CloudSecretsErrorCode = 'not_configured'

export type CloudPanelSectionsLoad =
  | { status: 'loading' }
  | { status: 'failed'; error: CloudSecretsErrorCode }
  | { status: 'ready'; data: CloudPanelSectionsData }

/** Saves one value for a missing name; resolves to the refusal code, or null once saved. */
export type CloudPanelAddSecret = (
  name: string,
  value: string,
  scope: CloudSecretScope
) => Promise<CloudSecretsErrorCode | null>

export function useCloudPanelSections(args: {
  repoKey: string | null
  /** The sandbox's runtime environment, refreshed after a save while it's awake. */
  runtimeEnvironmentId: string | null
  asleep: boolean
}): { load: CloudPanelSectionsLoad; reload: () => void; addSecret: CloudPanelAddSecret } {
  const { repoKey, runtimeEnvironmentId, asleep } = args
  const [load, setLoad] = useState<CloudPanelSectionsLoad>({ status: 'loading' })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const secrets = window.api.cloudSecrets
    if (!secrets) {
      setLoad({ status: 'failed', error: NOT_CONFIGURED })
      return
    }
    let cancelled = false
    void (async () => {
      const listing =
        window.api.orcaCloudEnvironments?.list().catch(() => null) ?? Promise.resolve(null)
      const sharing = runtimeEnvironmentId
        ? await secrets.workspaceSharing({ runtimeEnvironmentId }).catch(() => null)
        : null
      // SEC-5: a shared workspace (or one whose sharing can't be read) gets no Personal values, so ask
      // the control plane for exactly what such a workspace receives.
      const shared = runtimeEnvironmentId !== null && !(sharing?.ok && !sharing.value.shared)
      const [effective, list] = await Promise.all([
        secrets
          .effective({
            ...(repoKey ? { repo: repoKey } : {}),
            ...(shared ? { workspace: 'shared' as const } : {})
          })
          .catch(() => null),
        listing
      ])
      if (cancelled) {
        return
      }
      if (!effective || !effective.ok) {
        setLoad({ status: 'failed', error: effective?.ok === false ? effective.error : 'unknown' })
        return
      }
      const environment =
        repoKey && list?.ok ? environmentForRepo(list.data.environments, repoKey) : null
      setLoad({
        status: 'ready',
        data: cloudPanelSectionsData({
          effective: effective.value,
          envVarNames: environment?.envVarNames ?? null,
          repoKey,
          asleep,
          sharing: sharing?.ok ? sharing.value : null,
          // A sandbox whose sharing couldn't be read fails closed (D13).
          sharingUnknown: runtimeEnvironmentId !== null && !sharing?.ok
        })
      })
    })()
    return () => {
      cancelled = true
    }
  }, [repoKey, asleep, runtimeEnvironmentId, generation])

  const reload = useCallback(() => setGeneration((value) => value + 1), [])

  const addSecret = useCallback<CloudPanelAddSecret>(
    async (name, value, scope) => {
      const api = window.api.cloudSecrets
      if (!api) {
        return 'not_configured'
      }
      if (scope === 'repo' && !repoKey) {
        return 'repo_required'
      }
      const target = scope === 'repo' ? { scope, repo: repoKey ?? undefined } : { scope }
      const result = await api.put({ target, name, value }).catch(() => null)
      if (!result || !result.ok) {
        return result?.ok === false ? result.error : 'unknown'
      }
      // An awake sandbox picks it up now; an asleep one gets it when it wakes.
      if (!asleep && runtimeEnvironmentId) {
        void api.refreshEnv({ runtimeEnvironmentId }).catch(() => {})
      }
      setGeneration((current) => current + 1)
      return null
    },
    [repoKey, asleep, runtimeEnvironmentId]
  )

  return { load, reload, addSecret }
}
