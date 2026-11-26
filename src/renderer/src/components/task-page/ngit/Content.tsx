import { useState } from 'react'
import { LoaderCircle, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import TaskProjectSourceCombobox from '@/components/task-page/source-selection/task-project-source-combobox'
import { useTranslate } from '@/i18n/use-translate'
import { getWorkItemRepo } from '@/lib/work-items/work-item-repo-row'
import { normalizeTaskRepoSelection } from '../../../../../shared/work-items/task-repo-selection'
import type { NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { NgitFilterChip } from './ngit-filter-chip'
import { NgitItemList } from './ngit-item-list'
import { NgitItemSheet } from './ngit-item-sheet'
import { NgitNewIssueDialog } from './ngit-new-issue-dialog'
import { filterNgitItems, type NgitStateFilter, type NgitView } from './ngit-item-filter'
import { useNgitWorkItems } from './use-ngit-work-items'
import { useNgitWorkspaceStart } from './use-ngit-workspace-start'
import { findNgitItemWorkspace } from './ngit-item-workspace'
import type { Worktree } from '../../../../../shared/worktree/types'

export function TaskPageNgitContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const t = useTranslate()
  const {
    updateSettings,
    eligibleRepos,
    selectedRepos,
    selectedReposKey,
    repoSelection,
    setRepoSelection,
    taskPickerGroups,
    taskPickerRepos,
    getTaskPickerRepoHostLabel,
    allWorktrees
  } = model
  const [view, setView] = useState<NgitView>('issues')
  const [stateFilter, setStateFilter] = useState<NgitStateFilter>('open')
  const [openItem, setOpenItem] = useState<NgitWorkItem | null>(null)
  const [creatingIssue, setCreatingIssue] = useState(false)
  const { items, ngitRepos, errors, loading, refresh } = useNgitWorkItems(
    selectedRepos,
    selectedReposKey
  )
  const workspaces = useNgitWorkspaceStart(selectedRepos)
  const workspaceOf = (item: NgitWorkItem): Worktree | null =>
    findNgitItemWorkspace(allWorktrees, getWorkItemRepo(selectedRepos, item), item)
  const openItemRepo = openItem ? getWorkItemRepo(selectedRepos, openItem) : undefined
  const saveSelection = (selection: string[] | null): void => {
    void updateSettings({ defaultRepoSelection: selection }).catch(() => {
      toast.error(t('auto.components.TaskPage.dfd72673e7', 'Failed to save project selection.'))
    })
  }
  const views: { id: NgitView; label: string }[] = [
    { id: 'issues', label: t('components.taskPage.ngit.viewIssues', 'Issues') },
    { id: 'prs', label: t('components.taskPage.ngit.viewPrs', 'PRs & patches') }
  ]
  const stateFilters: { id: NgitStateFilter; label: string }[] = [
    { id: 'open', label: t('components.taskPage.ngit.stateOpen', 'Open') },
    ...(view === 'prs'
      ? [{ id: 'merged' as const, label: t('components.taskPage.ngit.stateMerged', 'Merged') }]
      : []),
    { id: 'closed', label: t('components.taskPage.ngit.stateClosed', 'Closed') },
    { id: 'all', label: t('components.taskPage.ngit.stateAll', 'All') }
  ]
  const refreshLabel = t('components.taskPage.ngit.refreshList', 'Refresh ngit work items')

  return (
    <div className="mt-2 flex min-h-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {views.map(({ id, label }) => (
            <NgitFilterChip
              key={id}
              label={label}
              active={view === id}
              onSelect={() => {
                setView(id)
                setStateFilter('open')
              }}
            />
          ))}
        </div>
        <div className="w-full min-w-0 sm:w-[200px]">
          <TaskProjectSourceCombobox
            groups={taskPickerGroups}
            selected={repoSelection}
            getRepoHostLabel={getTaskPickerRepoHostLabel}
            onChange={(next) => {
              const normalized = normalizeTaskRepoSelection(eligibleRepos, next)
              setRepoSelection(normalized)
              saveSelection([...normalized])
            }}
            onSelectAll={() => {
              setRepoSelection(new Set(taskPickerRepos.map((repo) => repo.id)))
              saveSelection(null)
            }}
            triggerClassName="w-full"
          />
        </div>
      </div>
      <div className="flex min-h-0 flex-col">
        <div className="flex flex-none flex-wrap items-center justify-between gap-3 rounded-md rounded-b-none border border-border/50 bg-muted/50 px-3 py-2 shadow-sm">
          <div className="flex flex-wrap gap-2">
            {stateFilters.map(({ id, label }) => (
              <NgitFilterChip
                key={id}
                label={label}
                active={stateFilter === id}
                onSelect={() => setStateFilter(id)}
              />
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {view === 'issues' ? (
              <Button
                variant="outline"
                size="sm"
                disabled={ngitRepos.length === 0}
                onClick={() => setCreatingIssue(true)}
              >
                <Plus className="size-3.5" />
                {t('components.taskPage.ngit.newIssue', 'New issue')}
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={loading}
                  aria-label={refreshLabel}
                  onClick={refresh}
                >
                  {loading ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {refreshLabel}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {errors.length > 0 ? (
          <div className="flex-none border-x border-border/50 px-4 py-3 text-sm text-destructive">
            {errors.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </div>
        ) : null}
        <NgitItemList
          items={filterNgitItems(items, view, stateFilter)}
          loading={loading}
          emptyTitle={
            ngitRepos.length === 0
              ? t('components.taskPage.ngit.noRepoTitle', 'No ngit repository selected')
              : t('components.taskPage.ngit.emptyTitle', 'Nothing matches this filter')
          }
          emptyDescription={
            ngitRepos.length === 0
              ? t(
                  'components.taskPage.ngit.noRepoDescription',
                  'Select a project with a nostr:// remote or a maintainers.yaml file.'
                )
              : t('components.taskPage.ngit.emptyDescription', 'Try another state or refresh.')
          }
          onOpen={setOpenItem}
          workspaceOf={workspaceOf}
          onUse={workspaces.openOrStart}
          onStartNew={workspaces.start}
        />
      </div>
      {openItem && openItemRepo ? (
        <NgitItemSheet
          key={openItem.id}
          item={openItem}
          repo={openItemRepo}
          hasWorkspace={workspaceOf(openItem) !== null}
          onClose={() => setOpenItem(null)}
          onChanged={refresh}
          onUse={(item) => {
            setOpenItem(null)
            workspaces.openOrStart(item)
          }}
        />
      ) : null}
      {creatingIssue ? (
        <NgitNewIssueDialog
          repos={ngitRepos}
          onClose={() => setCreatingIssue(false)}
          onCreated={refresh}
        />
      ) : null}
    </div>
  )
}
