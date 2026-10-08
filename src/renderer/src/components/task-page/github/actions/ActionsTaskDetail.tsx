import { ActionsArtifacts } from './ActionsArtifacts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionsRunDetailsContent } from '@/components/editor/ActionsRunDetailsPanel'
import { fetchActionsRunDetails } from '@/store/github/actions-requests'
import { actionsRepoProbeKey } from '@/components/right-sidebar/actions-repositories'
import type { ActionsRepositoryOption } from '@/components/right-sidebar/use-actions-repositories'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { ActionsRun } from '../../../../../../shared/github/actions-types'
import { useAppStore } from '@/store'

/** Fence detail reads by run and owner; append jobs only when the workflow attempt still matches. */
export function ActionsTaskDetail({
  option,
  run,
  onBack
}: {
  option: ActionsRepositoryOption
  run: ActionsRun
  onBack: () => void
}) {
  const generation = useRef(0)
  const [state, setState] = useState<NonNullable<OpenFile['checkRunDetails']>>({
    contextKey: `actions:${actionsRepoProbeKey(option.repo)}:${run.id}`,
    check: {
      name: run.displayTitle,
      status: 'queued',
      conclusion: null,
      url: run.htmlUrl,
      workflowRunId: run.id
    },
    details: null,
    loading: true,
    error: null
  })
  const stateRef = useRef(state)
  stateRef.current = state
  const load = useCallback(
    async (append = false): Promise<void> => {
      const current = stateRef.current
      if (append && (current.loading || !current.details?.actions?.hasNextPage)) {
        return
      }
      const request = ++generation.current
      const prior = current.details?.actions ? current.details : null
      setState((current) => ({ ...current, loading: true, error: null }))
      try {
        const next = await fetchActionsRunDetails(
          useAppStore.getState(),
          {
            repoId: option.repo.id,
            repoPath: option.repo.path,
            ownerKey: actionsRepoProbeKey(option.repo)
          },
          {
            repository: option.repository,
            runId: run.id,
            jobsPage: append && prior?.actions ? prior.actions.jobsPage + 1 : 1,
            expectedAttempt: append ? prior?.actions?.run.runAttempt : undefined,
            noCache: !append
          }
        )
        if (generation.current !== request) {
          return
        }
        const currentRepo = useAppStore.getState().repos.find((repo) => repo.id === option.repo.id)
        if (!currentRepo || actionsRepoProbeKey(currentRepo) !== actionsRepoProbeKey(option.repo)) {
          return
        }
        if (
          append &&
          next.actions.jobsError &&
          next.actions.run.runAttempt === prior?.actions?.run.runAttempt
        ) {
          setState((current) => ({ ...current, loading: false, error: next.actions.jobsError }))
          return
        }
        const details =
          append &&
          prior?.actions &&
          next.actions.run.runAttempt === prior.actions.run.runAttempt &&
          next.actions.jobsPage > 1
            ? {
                ...next,
                jobs: [...prior.jobs, ...next.jobs],
                actions: {
                  ...next.actions,
                  logWarnings: [...prior.actions.logWarnings, ...next.actions.logWarnings]
                }
              }
            : next
        setState((current) => ({ ...current, details, loading: false, error: null }))
      } catch (error) {
        if (generation.current === request) {
          setState((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }))
        }
      }
    },
    [option, run.id]
  )
  useEffect(() => {
    void load()
    return () => {
      generation.current += 1
    }
  }, [load])
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50">
      <ActionsRunDetailsContent
        state={state}
        refresh={() => {
          void load()
        }}
        loadMore={() => {
          void load(true)
        }}
        onBack={onBack}
        artifacts={<ActionsArtifacts option={option} runId={run.id} />}
      />
    </div>
  )
}
