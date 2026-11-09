import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PreloadApi } from '../../../../../preload/api-types'
import type {
  CloudSecretBatchResult,
  CloudSecretTarget,
  CloudSecretView,
  CloudSecretsEffective,
  CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'

export type CloudSecretsApi = NonNullable<PreloadApi['cloudSecrets']>

export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'failed'; error: CloudSecretsErrorCode }

function useLoad<T>(
  key: string | null,
  read: () => Promise<{ ok: true; value: T } | { ok: false; error: CloudSecretsErrorCode }>
): [Loadable<T>, (update: (value: T) => T) => void, () => void] {
  const [state, setState] = useState<{ key: string | null; loaded: Loadable<T> }>({
    key,
    loaded: { status: 'loading' }
  })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (key === null) {
      return
    }
    let cancelled = false
    setState((current) => (current.key === key ? current : { key, loaded: { status: 'loading' } }))
    void read().then(
      (result) => {
        if (!cancelled) {
          setState({
            key,
            loaded: result.ok
              ? { status: 'ready', value: result.value }
              : { status: 'failed', error: result.error }
          })
        }
      },
      () => {
        if (!cancelled) {
          setState({ key, loaded: { status: 'failed', error: 'unknown' } })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [key, read, generation])

  const update = useCallback((apply: (value: T) => T) => {
    setState((current) =>
      current.loaded.status === 'ready'
        ? { ...current, loaded: { status: 'ready', value: apply(current.loaded.value) } }
        : current
    )
  }, [])
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  const loaded: Loadable<T> = state.key === key ? state.loaded : { status: 'loading' }
  return [loaded, update, reload]
}

export function cloudSecretTargetKey(target: CloudSecretTarget): string {
  return target.scope === 'repo' ? `repo:${target.repo ?? ''}` : target.scope
}

export type CloudSecretListModel = {
  list: Loadable<CloudSecretView[]>
  reload: () => void
  /** Resolves to the failure code, or null once saved. The value is not kept anywhere. */
  put: (name: string, value: string) => Promise<CloudSecretsErrorCode | null>
  remove: (name: string) => Promise<CloudSecretsErrorCode | null>
  batch: (set: Record<string, string>) => Promise<CloudSecretBatchResult | CloudSecretsErrorCode>
}

function upsert(list: CloudSecretView[], secret: CloudSecretView): CloudSecretView[] {
  const rest = list.filter((entry) => entry.name !== secret.name)
  return [...rest, secret].sort((a, b) => a.name.localeCompare(b.name))
}

/** One scope's names and hints. A repo scope with no repo picked loads nothing. */
export function useCloudSecretList(
  api: CloudSecretsApi,
  scope: CloudSecretTarget['scope'],
  repo: string | null,
  onChanged?: () => void
): CloudSecretListModel {
  const target = useMemo<CloudSecretTarget | null>(
    () => (scope !== 'repo' ? { scope } : repo ? { scope, repo } : null),
    [scope, repo]
  )
  const key = target ? cloudSecretTargetKey(target) : null
  const read = useCallback(
    async () => (target ? api.list(target) : { ok: true as const, value: [] }),
    [api, target]
  )
  const [list, update, reload] = useLoad<CloudSecretView[]>(key, read)

  const put = useCallback(
    async (name: string, value: string): Promise<CloudSecretsErrorCode | null> => {
      if (!target) {
        return 'repo_required'
      }
      const result = await api.put({ target, name, value }).catch(() => null)
      if (!result) {
        return 'unknown'
      }
      if (!result.ok) {
        return result.error
      }
      update((current) => upsert(current, result.value))
      onChanged?.()
      return null
    },
    [api, target, update, onChanged]
  )

  const remove = useCallback(
    async (name: string): Promise<CloudSecretsErrorCode | null> => {
      if (!target) {
        return 'repo_required'
      }
      const result = await api.remove({ target, name }).catch(() => null)
      if (!result) {
        return 'unknown'
      }
      if (!result.ok) {
        return result.error
      }
      update((current) => current.filter((entry) => entry.name !== name))
      onChanged?.()
      return null
    },
    [api, target, update, onChanged]
  )

  const batch = useCallback(
    async (
      set: Record<string, string>
    ): Promise<CloudSecretBatchResult | CloudSecretsErrorCode> => {
      if (!target) {
        return 'repo_required'
      }
      const result = await api.batch({ target, set }).catch(() => null)
      if (!result) {
        return 'unknown'
      }
      if (!result.ok) {
        return result.error
      }
      update((current) => result.value.secrets.reduce(upsert, current))
      onChanged?.()
      return result.value
    },
    [api, target, update, onChanged]
  )

  return { list, reload, put, remove, batch }
}

/** Who the caller is (role gating) and which scope wins per name, optionally for one repo. */
export function useCloudSecretsEffective(
  api: CloudSecretsApi,
  repo: string | null
): { effective: Loadable<CloudSecretsEffective>; reload: () => void } {
  const read = useCallback(() => api.effective(repo ? { repo } : {}), [api, repo])
  const [effective, , reload] = useLoad<CloudSecretsEffective>(`effective:${repo ?? ''}`, read)
  return { effective, reload }
}
