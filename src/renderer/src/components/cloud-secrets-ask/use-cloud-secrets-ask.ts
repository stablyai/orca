// Loads what S2 and the panel's section 3 need for one repo: the org environment that lists it and the
// caller's effective Cloud secrets. Two reads, no new endpoint; nothing here wakes a sandbox.
import { cloudWorkspaceSecretsMode } from '@/lib/orca-cloud/cloud-workspace-secrets-mode'
import { useCallback, useEffect, useState } from 'react'
import {
  cloudSecretsErrorCode,
  type CloudSecretBatchResult,
  type CloudSecretScope,
  type CloudSecretsEffective,
  type CloudSecretsErrorCode
} from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import type { HostedEnvironmentListEntry } from '../../../../shared/hosted-sandbox/hosted-environment-wire'
import {
  cloudSecretsAskData,
  environmentForRepo,
  type CloudSecretsAskData
} from './cloud-secrets-ask-model'

const UNAVAILABLE: CloudSecretsErrorCode = 'unavailable'
const NOT_CONFIGURED: CloudSecretsErrorCode = 'not_configured'

export type CloudSecretsAskLoad =
  | { status: 'loading' }
  /** No Cloud, no environment for this repo, or nothing declared: S2 stays hidden. */
  | { status: 'none' }
  | { status: 'failed'; error: CloudSecretsErrorCode }
  | {
      status: 'ready'
      data: CloudSecretsAskData
      effective: CloudSecretsEffective
      environment: HostedEnvironmentListEntry
    }

export function useCloudSecretsAskLoad(
  repoKey: string | null,
  /** The workspace's runtime environment; its sharing decides whether Personal values count (SEC-5). */
  runtimeEnvironmentId: string | null = null
): {
  load: CloudSecretsAskLoad
  reload: () => void
} {
  const [load, setLoad] = useState<CloudSecretsAskLoad>({ status: 'loading' })
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const secrets = window.api.cloudSecrets
    const environments = window.api.orcaCloudEnvironments
    if (!repoKey || !secrets || !environments) {
      setLoad({ status: 'none' })
      return
    }
    let cancelled = false
    void (async () => {
      const [list, mode] = await Promise.all([
        environments.list().catch(() => null),
        cloudWorkspaceSecretsMode(runtimeEnvironmentId)
      ])
      const effective = await secrets
        .effective({ repo: repoKey, ...(mode === 'shared' ? { workspace: mode } : {}) })
        .catch(() => null)
      if (cancelled) {
        return
      }
      // A list that failed isn't "no environment": the caller must not take it as nothing missing.
      if (!list || !list.ok) {
        setLoad({ status: 'failed', error: UNAVAILABLE })
        return
      }
      const environment = environmentForRepo(list.data.environments, repoKey)
      if (!environment) {
        setLoad({ status: 'none' })
        return
      }
      if (!effective || !effective.ok) {
        setLoad({ status: 'failed', error: effective?.ok === false ? effective.error : 'unknown' })
        return
      }
      setLoad({
        status: 'ready',
        data: cloudSecretsAskData({
          environment,
          effective: effective.value,
          repoKey,
          shared: mode === 'shared'
        }),
        effective: effective.value,
        environment
      })
    })()
    return () => {
      cancelled = true
    }
  }, [repoKey, runtimeEnvironmentId, generation])
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  return { load, reload }
}

export type CloudSecretsSaveResult =
  | { ok: true; saved: string[]; refused: Record<string, CloudSecretsErrorCode> }
  | { ok: false; error: CloudSecretsErrorCode }

const TRANSPORT: ReadonlySet<CloudSecretsErrorCode> = new Set(['unavailable', 'timeout', 'unknown'])

/**
 * One batch per scope (usually one), then the existing env refresh for a running sandbox. A transport
 * failure before anything was written reports "nothing changed"; per-name refusals come back by name.
 */
export async function saveMissingSecrets(args: {
  values: Record<string, string>
  scopes: Record<string, CloudSecretScope>
  repoKey: string | null
  /** The sandbox's runtime environment, when it is up and should pick the values up now. */
  refreshRuntimeEnvironmentId: string | null
}): Promise<CloudSecretsSaveResult> {
  const api = window.api.cloudSecrets
  if (!api) {
    return { ok: false, error: NOT_CONFIGURED }
  }
  const byScope = new Map<CloudSecretScope, Record<string, string>>()
  for (const [name, value] of Object.entries(args.values)) {
    if (!value) {
      continue
    }
    const scope = args.scopes[name] ?? 'personal'
    byScope.set(scope, { ...byScope.get(scope), [name]: value })
  }
  const saved: string[] = []
  const refused: Record<string, CloudSecretsErrorCode> = {}
  for (const [scope, set] of byScope) {
    if (scope === 'repo' && !args.repoKey) {
      for (const name of Object.keys(set)) {
        refused[name] = 'repo_required'
      }
      continue
    }
    const target = scope === 'repo' ? { scope, repo: args.repoKey ?? undefined } : { scope }
    const result = await api.batch({ target, set }).catch(() => null)
    if (!result || !result.ok) {
      const error: CloudSecretsErrorCode = result?.ok === false ? result.error : 'unknown'
      if (TRANSPORT.has(error) && saved.length === 0) {
        return { ok: false, error }
      }
      for (const name of Object.keys(set)) {
        refused[name] = error
      }
      continue
    }
    collect(result.value, saved, refused)
  }
  if (saved.length > 0 && args.refreshRuntimeEnvironmentId) {
    void api.refreshEnv({ runtimeEnvironmentId: args.refreshRuntimeEnvironmentId }).catch(() => {})
  }
  return { ok: true, saved, refused }
}

function collect(
  result: CloudSecretBatchResult,
  saved: string[],
  refused: Record<string, CloudSecretsErrorCode>
): void {
  for (const secret of result.secrets) {
    saved.push(secret.name)
  }
  for (const error of result.errors) {
    refused[error.name] = cloudSecretsErrorCode(error.reason ?? error.error)
  }
}
