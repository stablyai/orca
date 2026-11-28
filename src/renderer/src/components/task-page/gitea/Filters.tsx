import { useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RailPagePrimaryButton, RailPageRefreshButton } from '@/components/rail-page/RailPageHeader'
import { RailPageFilterButton, RailPageViews } from '@/components/rail-page/RailPageToolbar'
import { TaskPageListBands } from '../ListBands'
import { TaskPageRepositoryScope } from '../RepositoryScope'
import { TaskFilterChip } from '../TaskFilterChip'
import { GiteaNewIssueDialog } from './NewIssueDialog'
import { getGiteaTaskFilters, getGiteaTaskViews } from './gitea-task-options'
import { giteaTaskRepoScope } from './use-task-page-gitea-list'

export function TaskPageGiteaFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const t = useTranslate()
  const createGiteaIssue = useAppStore((s) => s.createGiteaIssue)
  const [newIssueOpen, setNewIssueOpen] = useState(false)
  const {
    primaryRepo,
    giteaView,
    setGiteaView,
    giteaFilter,
    setGiteaFilter,
    giteaLoading,
    setGiteaRefreshNonce
  } = model
  const actions = (
    <>
      <RailPageRefreshButton
        label={t('auto.components.GiteaTaskList.e3db16e7c7', 'Refresh Gitea tasks')}
        busy={giteaLoading}
        onRefresh={() => setGiteaRefreshNonce((n) => n + 1)}
      />
      <RailPagePrimaryButton
        icon={<Plus className="size-3.5" />}
        label={t('common.new', 'New')}
        aria-label={t('auto.components.GiteaTaskList.5997067bee', 'New issue')}
        disabled={!primaryRepo}
        onClick={() => setNewIssueOpen(true)}
      />
    </>
  )
  const controls = (
    <Popover>
      <PopoverTrigger asChild>
        <RailPageFilterButton activeCount={Number(giteaFilter !== 'all')} />
      </PopoverTrigger>
      <PopoverContent align="end">
        <div className="flex flex-wrap gap-2 p-2">
          {getGiteaTaskFilters().map(({ id, label }) => (
            <TaskFilterChip
              key={id}
              label={label}
              active={giteaFilter === id}
              onSelect={() => setGiteaFilter(id)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )

  return (
    <>
      <TaskPageListBands
        model={model}
        scope={<TaskPageRepositoryScope model={model} />}
        views={
          <RailPageViews
            label={t('auto.components.TaskPage.giteaSourceLabel', 'Gitea')}
            value={giteaView}
            onValueChange={setGiteaView}
            items={getGiteaTaskViews().map(({ id, label }) => ({ value: id, label }))}
          />
        }
        actions={actions}
        controls={controls}
      />
      {primaryRepo ? (
        <GiteaNewIssueDialog
          open={newIssueOpen}
          onOpenChange={setNewIssueOpen}
          repoName={primaryRepo.displayName}
          onCreate={async (title, body) => {
            const result = await createGiteaIssue(giteaTaskRepoScope(primaryRepo), {
              title,
              body
            }).catch((error: unknown) => ({
              ok: false as const,
              error:
                error instanceof Error
                  ? error.message
                  : t('auto.components.TaskPage.giteaCreateIssueFailed', 'Failed to create issue.')
            }))
            if (!result.ok) {
              toast.error(result.error)
              return false
            }
            setGiteaRefreshNonce((n) => n + 1)
            return true
          }}
        />
      ) : null}
    </>
  )
}
