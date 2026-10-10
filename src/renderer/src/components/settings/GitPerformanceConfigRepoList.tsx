import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type {
  GitPerformanceConfigAction,
  GitTuningMode,
  RepoPerformanceConfigOutcome
} from '../../../../shared/git-performance-config-types'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  describeOrcaKeys,
  describeSkippedKeys,
  describeUnavailable,
  describeUserKeys
} from './git-performance-config-copy'

type RowState = {
  busy: GitPerformanceConfigAction | null
  outcome: RepoPerformanceConfigOutcome | null
}

// Why: runtime rows belong to another Orca host, which applies its own setting.
function isConfigurableHere(repo: Repo): boolean {
  return (
    isGitRepoKind(repo) && parseExecutionHostId(getRepoExecutionHostId(repo))?.kind !== 'runtime'
  )
}

// Why optional: the web client and static unit-test renders have no repository-config channel.
function getPerformanceConfigApi() {
  return typeof window === 'undefined' ? undefined : window.api?.repos?.performanceConfig
}

function rowStatus(state: RowState | undefined): string {
  if (state?.busy === 'apply') {
    return translate('auto.components.settings.GitPerformanceConfig.applying', 'Applying…')
  }
  if (state?.busy === 'revert') {
    return translate('auto.components.settings.GitPerformanceConfig.reverting', 'Removing…')
  }
  const outcome = state?.outcome
  if (!outcome) {
    return translate('auto.components.settings.GitPerformanceConfig.checking', 'Checking…')
  }
  if (outcome.status === 'unavailable') {
    return describeUnavailable(outcome.reason)
  }
  return describeOrcaKeys(outcome.state.orcaKeys.map((entry) => `${entry.key}=${entry.value}`))
}

function rowDetails(outcome: RepoPerformanceConfigOutcome | null): string[] {
  if (!outcome) {
    return []
  }
  if (outcome.status === 'unavailable') {
    return outcome.message ? [outcome.message] : []
  }
  return [
    describeUserKeys(outcome.state.userKeys),
    outcome.plan ? describeSkippedKeys(outcome.plan) : null
  ].filter((line): line is string => line !== null)
}

export function GitPerformanceConfigRepoList({
  mode,
  refreshSignal
}: {
  mode: GitTuningMode
  /** Bumped after the setting is persisted, so reads queue behind main's revert. */
  refreshSignal: number
}): React.JSX.Element | null {
  const repos = useAppStore((s) => s.repos)
  const performanceConfig = getPerformanceConfigApi()
  const configurable = useMemo(() => repos.filter(isConfigurableHere), [repos])
  const repoIdsKey = configurable.map((repo) => repo.id).join('\n')
  const [rows, setRows] = useState<Record<string, RowState>>({})

  const run = useCallback(
    async (repoId: string, action: GitPerformanceConfigAction) => {
      if (!performanceConfig) {
        return
      }
      setRows((prev) => ({
        ...prev,
        [repoId]: { busy: action, outcome: prev[repoId]?.outcome ?? null }
      }))
      let outcome: RepoPerformanceConfigOutcome
      try {
        outcome = await performanceConfig({ repoId, action })
      } catch (error) {
        outcome = {
          status: 'unavailable',
          reason: 'failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }
      setRows((prev) => ({ ...prev, [repoId]: { busy: null, outcome } }))
    },
    [performanceConfig]
  )

  useEffect(() => {
    for (const repoId of repoIdsKey.split('\n').filter(Boolean)) {
      void run(repoId, 'inspect')
    }
  }, [repoIdsKey, refreshSignal, run])

  if (!performanceConfig || configurable.length === 0) {
    return null
  }

  const readyIds = configurable
    .map((repo) => repo.id)
    .filter((id) => rows[id]?.outcome?.status === 'ok' && !rows[id]?.busy)

  return (
    <div className="space-y-2" data-testid="git-performance-config-repos">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('auto.components.settings.GitPerformanceConfig.repositories', 'Repositories')}
        </p>
        {mode === 'recommended' ? (
          <Button
            size="xs"
            disabled={readyIds.length === 0}
            onClick={() => {
              for (const repoId of readyIds) {
                void run(repoId, 'apply')
              }
            }}
          >
            {translate(
              'auto.components.settings.GitPerformanceConfig.applyToExisting',
              'Apply to existing repositories'
            )}
          </Button>
        ) : null}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {configurable.map((repo) => {
          const state = rows[repo.id]
          const outcome = state?.outcome ?? null
          const hasOrcaKeys = outcome?.status === 'ok' && outcome.state.orcaKeys.length > 0
          const canAct = outcome?.status === 'ok' && !state?.busy
          return (
            <li
              key={repo.id}
              className="flex items-start justify-between gap-4 px-3 py-2"
              data-testid="git-performance-config-repo"
              data-repo-id={repo.id}
            >
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-[13px]">{repo.displayName}</p>
                <p className="text-xs text-muted-foreground">{rowStatus(state)}</p>
                {rowDetails(outcome).map((line) => (
                  <p key={line} className="text-[11px] text-muted-foreground">
                    {line}
                  </p>
                ))}
              </div>
              <div className="flex shrink-0 gap-1">
                {mode === 'recommended' ? (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={!canAct}
                    onClick={() => void run(repo.id, 'apply')}
                  >
                    {translate('auto.components.settings.GitPerformanceConfig.apply', 'Apply')}
                  </Button>
                ) : null}
                {hasOrcaKeys ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!canAct}
                    onClick={() => void run(repo.id, 'revert')}
                  >
                    {translate('auto.components.settings.GitPerformanceConfig.revert', 'Remove')}
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
