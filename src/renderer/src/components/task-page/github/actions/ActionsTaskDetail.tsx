import { translate } from '@/i18n/i18n'
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
  const { id: repoId, path: repoPath } = option.repo
  const ownerKey = actionsRepoProbeKey(option.repo)
  const { owner, repo: repoName, host } = option.repository
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
  const updateState = useCallback((update: (current: typeof state) => typeof state): void => {
    const next = update(stateRef.current)
    stateRef.current = next
    setState(next)
  }, [])
  const load = useCallback(
    async (append = false, attempt?: number | null): Promise<void> => {
      const current = stateRef.current
      if (append && (current.loading || !current.details?.actions?.hasNextPage)) {
        return
      }
      const request = ++generation.current
      const selectedAttempt = attempt === undefined ? (current.actionsAttempt ?? null) : attempt
      const prior =
        current.details?.actions && selectedAttempt === (current.actionsAttempt ?? null)
          ? current.details
          : null
      updateState((current) => ({
        ...current,
        details: prior,
        actionsAttempt: selectedAttempt,
        loading: true,
        error: null
      }))
      try {
        const next = await fetchActionsRunDetails(
          useAppStore.getState(),
          {
            repoId,
            repoPath,
            ownerKey
          },
          {
            repository: { owner, repo: repoName, host },
            runId: run.id,
            attempt: selectedAttempt ?? undefined,
            jobsPage: append && prior?.actions ? prior.actions.jobsPage + 1 : 1,
            expectedAttempt: append ? prior?.actions?.run.runAttempt : undefined,
            noCache: !append
          }
        )
        if (generation.current !== request) {
          return
        }
        if (selectedAttempt !== null && next.actions.run.runAttempt !== selectedAttempt) {
          throw new Error(
            translate(
              'actions.attemptUnsupported',
              'The host did not return the selected attempt. Update the host and retry.'
            )
          )
        }
        const currentRepo = useAppStore.getState().repos.find((repo) => repo.id === repoId)
        if (!currentRepo || actionsRepoProbeKey(currentRepo) !== ownerKey) {
          throw new Error(
            translate(
              'actions.ownerChanged',
              'Repository host or account changed. Reopen this run from Actions.'
            )
          )
        }
        if (
          append &&
          next.actions.jobsError &&
          next.actions.run.runAttempt === prior?.actions?.run.runAttempt
        ) {
          updateState((current) => ({ ...current, loading: false, error: next.actions.jobsError }))
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
                  ...prior.actions,
                  ...next.actions,
                  logWarnings: [...prior.actions.logWarnings, ...next.actions.logWarnings]
                }
              }
            : next
        updateState((current) => ({ ...current, details, loading: false, error: null }))
      } catch (error) {
        if (generation.current === request) {
          updateState((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }))
        }
      }
    },
    [repoId, repoPath, ownerKey, owner, repoName, host, run.id, updateState]
  )
  useEffect(() => {
    updateState((current) => ({
      ...current,
      contextKey: `actions:${ownerKey}:${run.id}`,
      check: {
        name: run.displayTitle,
        status: 'queued',
        conclusion: null,
        url: run.htmlUrl,
        workflowRunId: run.id
      },
      actionsAttempt: null,
      details: null,
      loading: true,
      error: null
    }))
    void load(false, null)
    return () => {
      generation.current += 1
    }
  }, [load, ownerKey, run.id, run.displayTitle, run.htmlUrl, updateState])
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/50">
      <ActionsRunDetailsContent
        state={state}
        onAttemptChange={(attempt) => {
          void load(false, attempt)
        }}
        refresh={() => {
          void load()
        }}
        loadMore={() => {
          void load(true)
        }}
        onBack={onBack}
        artifacts={
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {translate(
                'actions.artifacts.runScope',
                'Run artifacts are not filtered by attempt.'
              )}
            </p>
            <ActionsArtifacts option={option} runId={run.id} />
          </div>
        }
      />
    </div>
  )
}
