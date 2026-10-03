import { useState } from 'react'
import { useActionsRepositories } from '@/components/right-sidebar/use-actions-repositories'
import { useActionsRuns } from '@/components/right-sidebar/use-actions-runs'
import { actionsRepoProbeKey } from '@/components/right-sidebar/actions-repositories'
import { ActionsChoice } from '@/components/right-sidebar/ActionsChoice'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { ActionsFilters } from './ActionsFilters'
import { ActionsList } from './ActionsList'
import { ActionsTaskDetail } from './ActionsTaskDetail'
import type { ActionsRun } from '../../../../../../shared/github/actions-types'

/** Require a verified registered GitHub repository before exposing run browsing and download controls. */
export function TaskPageActions({ selectedRepoIds }: { selectedRepoIds: ReadonlySet<string> }) {
  const repositories = useActionsRepositories(null, selectedRepoIds)
  const [repoId, setRepoId] = useState('')
  const option =
    repositories.options.find((entry) => entry.repo.id === repoId) ??
    (repositories.options.length === 1 ? repositories.options[0] : undefined)
  return (
    <div className="mt-3 flex min-h-0 min-w-0 flex-1 flex-col">
      {repositories.options.length > 1 && (
        <div className="mb-2">
          <ActionsChoice
            value={option?.repo.id ?? ''}
            label={translate('actions.chooseRepo', 'Choose repository')}
            options={repositories.options.map((entry) => ({
              value: entry.repo.id,
              label: `${entry.repo.displayName} · ${entry.repository.owner}/${entry.repository.repo}`
            }))}
            onChange={setRepoId}
          />
        </div>
      )}
      {repositories.loading && (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {translate('actions.resolving', 'Checking repository…')}
        </p>
      )}
      {repositories.error && (
        <div role="alert" className="flex items-center gap-3 p-4 text-sm text-destructive">
          {repositories.error}
          <Button variant="outline" size="sm" onClick={repositories.retry}>
            {translate('actions.retry', 'Retry')}
          </Button>
        </div>
      )}
      {option ? (
        <ActionsRepositoryPage key={actionsRepoProbeKey(option.repo)} option={option} />
      ) : (
        !repositories.loading &&
        !repositories.error && (
          <p className="p-4 text-sm text-muted-foreground">
            {repositories.options.length
              ? translate('actions.selectRepo', 'Select a repository to browse workflow runs.')
              : translate(
                  'actions.unavailable',
                  'Actions is available for registered GitHub repositories. Add or open a GitHub repository to continue.'
                )}
          </p>
        )
      )}
    </div>
  )
}

/** Reset run selection when repository ownership changes while keeping list/detail navigation local to Tasks. */
function ActionsRepositoryPage({
  option
}: {
  option: NonNullable<ReturnType<typeof useActionsRepositories>['options'][number]>
}) {
  const model = useActionsRuns(option)
  const [run, setRun] = useState<ActionsRun | null>(null)
  return run ? (
    <ActionsTaskDetail option={option} run={run} onBack={() => setRun(null)} />
  ) : (
    <>
      <ActionsFilters model={model} option={option} />
      <ActionsList model={model} onOpen={setRun} />
    </>
  )
}
