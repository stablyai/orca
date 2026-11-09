import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type {
  CloudApiInstallation,
  CloudApiProject,
  Routine
} from '../../../../../shared/cloud-api/cloud-api-types'
import { CloudApiSignedOutNotice } from './CloudApiSignedOutNotice'
import { CloudRoutinesView } from './CloudRoutinesView'
import { cloudApiErrorCopy } from './cloud-api-copy'
import { localTimeZone } from './cloud-api-format'
import { toCloudLoadState, type CloudApiFailure, type CloudLoadState } from './cloud-load-state'
import { useOrcaCloudApiAvailability } from '@/hooks/useOrcaCloudApiAvailability'
import { useRequestGeneration } from './use-request-generation'

const RUNS_PAGE_SIZE = 20

export function CloudRoutinesPane(): React.JSX.Element | null {
  const t = useTranslate()
  const availability = useOrcaCloudApiAvailability()
  const api = window.api.cloudApi
  const [routines, setRoutines] = useState<CloudLoadState<Routine[]>>({ status: 'loading' })
  const [projects, setProjects] = useState<CloudApiProject[]>([])
  const [projectsFailed, setProjectsFailed] = useState(false)
  const begin = useRequestGeneration()
  const [installations, setInstallations] = useState<CloudApiInstallation[] | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const timezone = useMemo(() => localTimeZone(), [])
  const word = useCallback(
    (failure: CloudApiFailure) => cloudApiErrorCopy(failure.error, t, failure),
    [t]
  )

  const load = useCallback(async (): Promise<void> => {
    if (!api) {
      return
    }
    const isCurrent = begin('page')
    setRoutines({ status: 'loading' })
    const [list, projectList, installs] = await Promise.all([
      api.listRoutines(),
      api.listProjects(),
      api.listInstallations()
    ])
    if (!isCurrent()) {
      return
    }
    setProjectsFailed(!projectList.ok)
    setRoutines(toCloudLoadState(list.ok ? { ok: true, data: list.data.routines } : list, word))
    setProjects(projectList.ok ? projectList.data.projects : [])
    setInstallations(installs.ok ? installs.data.installations : null)
    setNow(Date.now())
  }, [api, begin, word])

  // Stable identity: the run history reloads whenever this function changes.
  const loadRuns = useCallback(
    (routineId: string, before?: number | string) =>
      api
        ? api.listRoutineRuns(routineId, {
            limit: RUNS_PAGE_SIZE,
            ...(before !== undefined ? { before } : {})
          })
        : Promise.resolve({ ok: false as const, error: 'unconfigured' as const }),
    [api]
  )

  useEffect(() => {
    if (availability?.status === 'ready') {
      void load()
    }
  }, [availability?.status, load])

  const replace = (routine: Routine): void =>
    setRoutines((current) =>
      current.status === 'ok'
        ? { status: 'ok', data: current.data.map((r) => (r.id === routine.id ? routine : r)) }
        : current
    )

  if (!api || availability?.status !== 'ready') {
    return null
  }
  if (routines.status === 'error' && routines.code === 'signed-out') {
    return <CloudApiSignedOutNotice onRetry={() => void load()} />
  }
  return (
    <CloudRoutinesView
      routines={routines}
      projects={projects}
      projectsFailed={projectsFailed}
      installations={installations}
      now={now}
      localTimezone={timezone}
      onRefresh={() => void load()}
      onCreate={async (input) => {
        const result = await api.createRoutine(input)
        if (result.ok) {
          setRoutines((current) =>
            current.status === 'ok'
              ? { status: 'ok', data: [result.data.routine, ...current.data] }
              : current
          )
        }
        return result
      }}
      onUpdate={async (id, patch) => {
        const result = await api.updateRoutine(id, patch)
        if (result.ok) {
          replace(result.data.routine)
        }
        return result
      }}
      onToggle={async (routine, enabled) => {
        const result = await api.updateRoutine(routine.id, { enabled })
        if (!result.ok) {
          return word(result)
        }
        replace(result.data.routine)
        return null
      }}
      onRunNow={async (routine) => {
        const result = await api.runRoutine(routine.id)
        if (!result.ok) {
          return word(result)
        }
        replace({
          ...routine,
          lastRun: { id: result.data.run.id, status: result.data.run.status, finishedAt: null }
        })
        return null
      }}
      onDelete={async (routine) => {
        const result = await api.deleteRoutine(routine.id)
        if (!result.ok && result.error !== 'not-found') {
          return word(result)
        }
        setRoutines((current) =>
          current.status === 'ok'
            ? { status: 'ok', data: current.data.filter((r) => r.id !== routine.id) }
            : current
        )
        return null
      }}
      onRotateWebhook={(routine) => api.rotateRoutineWebhook(routine.id)}
      loadRuns={loadRuns}
    />
  )
}
