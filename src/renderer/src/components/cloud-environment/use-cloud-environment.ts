import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isBuildInProgress } from './cloud-environment-copy'
import type {
  EnvironmentApiError,
  EnvironmentBuildView,
  EnvironmentDraft,
  EnvironmentsApi,
  EnvironmentView
} from './cloud-environment-types'
import { draftFromEnvironment, draftPatch, upsertBuild } from './environment-draft'
import { useEnvironmentStaleness } from './use-environment-staleness'
import { idleActions, type ActionState } from './environment-action-state'
import { mergeBuildsByRecency, settledEnvironmentsApi } from './environment-api-safety'

/** Builds advance server-side; while one runs, re-read the history this often (the log streams). */
const IN_PROGRESS_POLL_MS = 8_000

export type CloudEnvironmentLoad =
  | { phase: 'loading' }
  | { phase: 'error'; error: EnvironmentApiError }
  | { phase: 'none'; canAdmin: boolean }
  | {
      phase: 'ready'
      environment: EnvironmentView
      builds: EnvironmentBuildView[]
      canAdmin: boolean
    }

export function useCloudEnvironment(rawApi: EnvironmentsApi) {
  const api = useMemo(() => settledEnvironmentsApi(rawApi), [rawApi])
  const [load, setLoad] = useState<CloudEnvironmentLoad>({ phase: 'loading' })
  const [actions, setActions] = useState<ActionState>(idleActions)
  const [reloadKey, setReloadKey] = useState(0)
  const envIdRef = useRef<string | null>(null)
  const { staleness, checkStaleness } = useEnvironmentStaleness(rawApi, envIdRef)

  // The environment as it was when the form's draft started: polls refresh `load.environment`
  // but must neither reset the user's draft nor move the revision their save is checked against.
  const [formBase, setFormBase] = useState<EnvironmentView | null>(null)

  // Only the newest read may land; polls skip while one is in flight.
  const readSeq = useRef(0)
  const reading = useRef(0)
  const readDetail = useCallback(
    async (envId: string, options: { background?: boolean; resetForm?: boolean } = {}) => {
      const seq = ++readSeq.current
      reading.current += 1
      const detail = await api.get(envId)
      reading.current -= 1
      if (seq !== readSeq.current) {
        return
      }
      if (detail.ok) {
        envIdRef.current = detail.data.environment.id
        setLoad((current) => ({
          phase: 'ready',
          environment: detail.data.environment,
          builds:
            current.phase === 'ready'
              ? mergeBuildsByRecency(current.builds, detail.data.builds)
              : detail.data.builds,
          canAdmin: detail.data.canAdmin
        }))
        if (!options.background || options.resetForm) {
          setFormBase(detail.data.environment)
        }
      } else if (!options.background) {
        setLoad({ phase: 'error', error: detail.error })
      }
    },
    [api]
  )

  useEffect(() => {
    let disposed = false
    void (async () => {
      const list = await api.list()
      if (disposed) {
        return
      }
      if (!list.ok) {
        setLoad({ phase: 'error', error: list.error })
        return
      }
      const first = list.data.environments[0]
      if (!first) {
        envIdRef.current = null
        setLoad({ phase: 'none', canAdmin: list.data.canAdmin })
        return
      }
      await readDetail(first.id)
      if (!disposed) {
        checkStaleness(first.id, false)
      }
    })()
    return () => {
      disposed = true
    }
  }, [api, readDetail, checkStaleness, reloadKey])

  const envId = load.phase === 'ready' ? load.environment.id : null
  const anyInProgress =
    load.phase === 'ready' && load.builds.some((build) => isBuildInProgress(build.status))
  useEffect(() => {
    if (!envId || !anyInProgress) {
      return
    }
    const timer = window.setInterval(() => {
      if (reading.current === 0) {
        void readDetail(envId, { background: true })
      }
    }, IN_PROGRESS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [envId, anyInProgress, readDetail])

  const applyBuild = useCallback((build: EnvironmentBuildView) => {
    setLoad((current) =>
      current.phase === 'ready'
        ? { ...current, builds: upsertBuild(current.builds, build) }
        : current
    )
  }, [])

  const reload = useCallback(() => {
    setActions(idleActions)
    setLoad((current) => (current.phase === 'error' ? { phase: 'loading' } : current))
    setReloadKey((key) => key + 1)
  }, [])

  const refreshAfterBuildEnd = useCallback(() => {
    const id = envIdRef.current
    if (id) {
      void readDetail(id, { background: true })
      checkStaleness(id, false)
    }
  }, [readDetail, checkStaleness])

  const startBuild = useCallback(
    async (id: string): Promise<EnvironmentBuildView | null> => {
      setActions((current) => ({
        ...current,
        starting: true,
        actionError: null
      }))
      const result = await api.startBuild(id)
      setActions((current) => ({
        ...current,
        starting: false,
        actionError: result.ok ? null : result.error.message
      }))
      if (result.ok) {
        applyBuild(result.data.build)
        return result.data.build
      }
      return null
    },
    [api, applyBuild]
  )

  const create = useCallback(
    async (draft: EnvironmentDraft): Promise<EnvironmentBuildView | null> => {
      setActions((current) => ({ ...current, saving: true, saveError: null }))
      const result = await api.create({
        name: draft.name.trim(),
        repos: draft.repos.map((repo) => ({
          url: repo.url,
          defaultBranch: repo.defaultBranch?.trim() || null
        })),
        installScript: draft.installScript,
        envVarNames: draft.envVarNames,
        machineSize: draft.machineSize
      })
      if (!result.ok) {
        setActions((current) => ({
          ...current,
          saving: false,
          saveError: result.error.message
        }))
        return null
      }
      const environment = result.data.environment
      envIdRef.current = environment.id
      setLoad({ phase: 'ready', environment, builds: [], canAdmin: true })
      setFormBase(environment)
      setActions((current) => ({ ...current, saving: false }))
      return startBuild(environment.id)
    },
    [api, startBuild]
  )

  const save = useCallback(
    async (environment: EnvironmentView, draft: EnvironmentDraft): Promise<void> => {
      const patch = draftPatch(draftFromEnvironment(environment), draft)
      if (Object.keys(patch).length === 0) {
        return
      }
      setActions((current) => ({
        ...current,
        saving: true,
        saveError: null,
        conflict: false
      }))
      const result = await api.update(environment.id, {
        ...patch,
        expectedRevision: environment.revision
      })
      if (!result.ok) {
        const conflict = result.error.reason === 'stale_revision'
        if (conflict) {
          // Learn who saved (and the new revision) without touching the user's draft.
          void readDetail(environment.id, { background: true })
        }
        setActions((current) => ({
          ...current,
          saving: false,
          conflict,
          saveError: conflict ? null : result.error.message
        }))
        return
      }
      setActions((current) => ({ ...current, saving: false }))
      setLoad((current) =>
        current.phase === 'ready' ? { ...current, environment: result.data.environment } : current
      )
      setFormBase(result.data.environment)
      checkStaleness(environment.id, false)
    },
    [api, checkStaleness, readDetail]
  )

  const reloadAfterConflict = useCallback(() => {
    const id = envIdRef.current
    setActions(idleActions)
    if (id) {
      void readDetail(id, { background: true, resetForm: true })
    }
  }, [readDetail])

  const cancel = useCallback(
    async (build: EnvironmentBuildView): Promise<void> => {
      const id = envIdRef.current
      if (!id) {
        return
      }
      setActions((current) => ({
        ...current,
        busyBuildId: build.id,
        actionError: null
      }))
      const result = await api.cancelBuild(id, build.id)
      setActions((current) => ({
        ...current,
        busyBuildId: null,
        actionError: result.ok ? null : result.error.message
      }))
      if (result.ok) {
        applyBuild(result.data.build)
      }
    },
    [api, applyBuild]
  )

  const activate = useCallback(
    async (build: EnvironmentBuildView): Promise<void> => {
      const id = envIdRef.current
      if (!id) {
        return
      }
      setActions((current) => ({
        ...current,
        busyBuildId: build.id,
        actionError: null
      }))
      const result = await api.activateBuild(id, build.id)
      setActions((current) => ({
        ...current,
        busyBuildId: null,
        actionError: result.ok ? null : result.error.message
      }))
      if (result.ok) {
        setLoad((current) =>
          current.phase === 'ready'
            ? {
                ...current,
                environment: result.data.environment,
                builds: current.builds.map((entry) => ({
                  ...entry,
                  active: entry.id === result.data.environment.activeBuildId
                }))
              }
            : current
        )
        checkStaleness(id, false)
      }
    },
    [api, checkStaleness]
  )

  return {
    load,
    formBase,
    staleness,
    actions,
    reload,
    applyBuild,
    refreshAfterBuildEnd,
    startBuild,
    create,
    save,
    reloadAfterConflict,
    cancel,
    activate
  }
}
