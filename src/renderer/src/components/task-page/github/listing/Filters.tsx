import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { getIssueTaskQueryPresets } from '@/components/task-page/task-page-localized-options'
import { cn } from '@/lib/class-names'
import PRFilterDropdowns, {
  PRFilterPills,
  getPRFilterPills
} from '@/components/github/PRFilterDropdowns'
import { filterStateLabel } from '@/components/github/PRFilterSections'
import { RailPagePrimaryButton, RailPageRefreshButton } from '@/components/rail-page/RailPageHeader'
import { RailPageSearch } from '@/components/rail-page/RailPageSearch'
import { TaskPageListBands } from '../../ListBands'
import { TaskPageRepositoryScope } from '../../RepositoryScope'
import { TaskPageGitHubViews } from './ModeControls'
import {
  getDefaultPresetForGitHubTaskKind,
  getGitHubTaskKind,
  normalizeGitHubTaskPreset
} from '../../../../../../shared/work-items/task-github-search'
import { getTaskPresetQuery } from '../../../../../../shared/work-items/task-preset-query'
import { parseTaskQuery } from '../../../../../../shared/work-items/task-query'
import { Search, X, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { resolveNewIssueOpenSeed } from '@/components/task-page/task-page-new-issue-draft'
import { useAppStore } from '@/store/index'
import { useShallow } from 'zustand/react/shallow'
import { getGitHubRepoRoutingTarget } from '@/lib/work-items/github/github-source-runtime-context'
import { hasUpstreamCandidateDivergence, hasDivergentSources } from '../../task-page-draft-storage'
import IssueSourceIndicator from '@/components/github/IssueSourceIndicator'
import IssueSourceSelector, { issueSourceChipClass } from '@/components/github/IssueSourceSelector'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'
import { deriveGitHubTaskPreset } from './task-page-preset-highlight'
import { deriveGitHubPRStateChip } from './task-page-pr-chips'

function PresetChip({
  label,
  active,
  onSelect,
  onSetDefault
}: {
  label: string
  active: boolean
  onSelect: () => void
  /** Right-click saves this chip as the default Tasks view. */
  onSetDefault?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      onContextMenu={
        onSetDefault
          ? (event) => {
              event.preventDefault()
              onSetDefault()
            }
          : undefined
      }
      className={cn(
        'rounded-md border px-2.5 py-1 text-xs font-medium transition',
        active
          ? 'border-border/50 bg-foreground/90 text-background shadow-xs'
          : 'border-border/60 bg-background text-foreground shadow-xs hover:bg-muted/60'
      )}
    >
      {label}
    </button>
  )
}
export function TaskPageGitHubListChrome({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const {
    setTaskResumeState,
    setIssueSourcePreference,
    selectedRepos,
    taskSearchInput,
    setTaskSearchInput,
    appliedTaskSearch,
    setAppliedTaskSearch,
    taskSearchInputRef,
    setActiveTaskPreset,
    setTaskRefreshNonce,
    perRepoSourceState,
    githubSourceDisplayState,
    handleRefreshGithubTasks,
    setNewIssueOpen,
    setNewIssueTitle,
    setNewIssueBody,
    setNewIssueLabels,
    setNewIssueAssignees,
    setNewIssueRepoId,
    newIssueTargetRepo,
    activeGithubTaskKind,
    appliedTaskQuery,
    loadedGitHubAuthorLogins,
    primaryGithubFilterSlug,
    applyPRFilterChange,
    handleTaskSearchChange,
    handleSetDefaultTaskPreset,
    handleResetGithubTaskSearch,
    handleTaskSearchKeyDown,
    githubTasksBusy
  } = model
  const savedPreset = normalizeGitHubTaskPreset(model.settings?.defaultTaskViewPreset)
  const savedQuery = getTaskPresetQuery(savedPreset)
  const defaultQuery =
    getGitHubTaskKind(savedPreset, savedQuery) === activeGithubTaskKind
      ? savedQuery
      : getTaskPresetQuery(getDefaultPresetForGitHubTaskKind(activeGithubTaskKind))
  const defaultFilters = parseTaskQuery(defaultQuery)
  const pills = getPRFilterPills(appliedTaskQuery, defaultFilters, t)
  const highlightedPreset = deriveGitHubTaskPreset(activeGithubTaskKind, appliedTaskQuery)
  const prStateChip = deriveGitHubPRStateChip(appliedTaskQuery)
  // Why: filter metadata for the primary slug is read from the host that owns the repo it came from.
  const primaryGithubFilterSource = perRepoSourceState.find((state) =>
    activeGithubTaskKind === 'prs' ? state.sources?.prs : state.sources?.issues
  )
  const primaryGithubFilterRepoId = primaryGithubFilterSource?.repoId ?? null
  // Why the host: a twin's two rows share the id, so only the source's row host names one.
  const primaryGithubFilterHostId = primaryGithubFilterSource?.hostId ?? null
  const primaryGithubFilterTarget = useAppStore(
    useShallow((s) =>
      getGitHubRepoRoutingTarget(s, primaryGithubFilterRepoId, null, primaryGithubFilterHostId)
    )
  )
  const views = <TaskPageGitHubViews model={model} />
  const scope = <TaskPageRepositoryScope model={model} />
  if (model.githubMode !== 'items') {
    return <TaskPageListBands model={model} scope={scope} views={views} />
  }
  const stateLabel = t('auto.components.TaskPage.issueFilterState', 'State')
  const presetLabel = t('auto.components.TaskPage.issueFilterPreset', 'Preset')
  const presets =
    activeGithubTaskKind === 'issues' ? (
      <div className="border-b border-border p-2">
        <div className="flex flex-col gap-2">
          <span aria-hidden className="text-2xs font-medium text-muted-foreground">
            {stateLabel}
          </span>
          <div role="group" aria-label={stateLabel} className="flex flex-wrap gap-1.5">
            {(['open', 'closed', 'all'] as const).map((state) => (
              <PresetChip
                key={state}
                label={
                  state === 'all'
                    ? t('auto.components.github.PRFilterDropdowns.anyState', 'Any')
                    : filterStateLabel(state, t)
                }
                active={prStateChip === state}
                onSelect={() => applyPRFilterChange({ state })}
              />
            ))}
          </div>
          <span aria-hidden className="text-2xs font-medium text-muted-foreground">
            {presetLabel}
          </span>
          <div role="group" aria-label={presetLabel} className="flex flex-wrap gap-1.5">
            {getIssueTaskQueryPresets().map(({ id, label, query }) => (
              <PresetChip
                key={id}
                label={label}
                active={highlightedPreset === id}
                onSelect={() => {
                  setTaskSearchInput(query)
                  setAppliedTaskSearch(query)
                  setActiveTaskPreset(id)
                  setTaskResumeState({
                    githubItemsPreset: id,
                    githubItemsQuery: query
                  })
                  setTaskRefreshNonce((current) => current + 1)
                }}
                onSetDefault={() => handleSetDefaultTaskPreset(id)}
              />
            ))}
          </div>
        </div>
      </div>
    ) : undefined
  const sourceNotices = (() => {
    // Why: show the source-slug chip only when the selector can't render (no upstream to toggle); otherwise it duplicates the selector.
    const rows = githubSourceDisplayState.filter(
      (s) => hasUpstreamCandidateDivergence(s) || hasDivergentSources(s)
    )
    if (rows.length === 0) {
      return null
    }
    return (
      <div className="flex flex-wrap items-center gap-2">
        {rows.map((s) => {
          // Why the host: a twin's rows share the id (and maybe the path); each row has its own preference.
          const repo = selectedRepos.find((r) => repoMatchesHostIdentity(r, s.repoId, s.hostId))
          const showRepoBadgeLabel = selectedRepos.length > 1 && repo
          const selectorRenderable = hasUpstreamCandidateDivergence(s)
          // Why: render the indicator standalone — it has its own chip styles, so nesting it in our chip would double-border it.
          if (!selectorRenderable && hasDivergentSources(s)) {
            return (
              <IssueSourceIndicator
                key={s.sourceKey}
                issues={s.sources.issues}
                prs={s.sources.prs}
                localRepo={
                  showRepoBadgeLabel && repo
                    ? {
                        displayName: repo.displayName,
                        color: repo.badgeColor
                      }
                    : undefined
                }
              />
            )
          }
          if (!selectorRenderable || !repo) {
            return null
          }
          // The selector renders a div; keep a block wrapper to avoid invalid nesting.
          return (
            <div key={s.sourceKey} className={issueSourceChipClass}>
              {showRepoBadgeLabel ? (
                <RepoBadgeLabel
                  name={repo.displayName}
                  color={repo.badgeColor}
                  repo={repo}
                  className="text-[10px] text-muted-foreground"
                />
              ) : null}
              <IssueSourceSelector
                preference={repo.issueSourcePreference}
                origin={s.sources.originCandidate}
                upstream={s.sources.upstreamCandidate}
                issueSource={s.sources.issues}
                onChange={(next) => {
                  void setIssueSourcePreference(repo.id, repo.path, next, s.hostId)
                }}
              />
            </div>
          )
        })}
      </div>
    )
  })()
  return (
    <TaskPageListBands
      model={model}
      scope={scope}
      views={views}
      actions={
        <>
          <RailPageRefreshButton
            busy={githubTasksBusy}
            busyCursor
            onRefresh={handleRefreshGithubTasks}
            label={
              githubTasksBusy
                ? t('auto.components.TaskPage.6ffa6be99f', 'Refreshing GitHub work')
                : t('auto.components.TaskPage.ff53631e6f', 'Refresh GitHub work')
            }
            tooltip={
              githubTasksBusy
                ? t('auto.components.TaskPage.31f81cc334', 'Refreshing GitHub work…')
                : undefined
            }
          />
          <RailPagePrimaryButton
            label={t('common.new', 'New')}
            icon={<Plus className="size-3.5" />}
            aria-label={t('auto.components.TaskPage.d3d0998b7d', 'New GitHub issue')}
            disabled={!newIssueTargetRepo}
            onClick={() => {
              // Why: restore a non-empty draft (accidental dismissal recoverable); empty default guards a stale draft after a repo change.
              const seed = resolveNewIssueOpenSeed({
                draft: useAppStore.getState().newIssueDraft,
                selectedRepoIds: selectedRepos.map((r) => r.id)
              })
              setNewIssueTitle(seed.title)
              setNewIssueBody(seed.body)
              setNewIssueLabels(seed.labels)
              setNewIssueAssignees(seed.assignees)
              setNewIssueRepoId(seed.repoId)
              setNewIssueOpen(true)
            }}
          />
        </>
      }
      controls={
        <>
          <PRFilterDropdowns
            parsed={appliedTaskQuery}
            defaultFilters={defaultFilters}
            kind={activeGithubTaskKind}
            authorLogins={loadedGitHubAuthorLogins}
            primarySlug={primaryGithubFilterSlug}
            ownerTarget={primaryGithubFilterTarget}
            onChange={applyPRFilterChange}
            onSetDefaultPreset={handleSetDefaultTaskPreset}
            activeCount={pills.length}
            presets={presets}
          />
          <RailPageSearch
            inputRef={taskSearchInputRef}
            hasValue={taskSearchInput !== defaultQuery && Boolean(taskSearchInput)}
          >
            <div className="relative w-full min-w-0">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={taskSearchInputRef}
                data-github-items-search-input
                value={taskSearchInput}
                onChange={handleTaskSearchChange}
                onKeyDown={handleTaskSearchKeyDown}
                placeholder={
                  activeGithubTaskKind === 'prs'
                    ? t('auto.components.TaskPage.eee4df4c66', 'Search GitHub PRs...')
                    : t('auto.components.TaskPage.b15ceb409d', 'Search GitHub issues...')
                }
                density="compact"
                surface="background"
                inset="leadingIcon"
                adornment={taskSearchInput === defaultQuery ? 'shortcutAndClear' : 'trailing'}
              />
              {taskSearchInput || appliedTaskSearch ? (
                <button
                  type="button"
                  aria-label={t('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
                  onClick={handleResetGithubTaskSearch}
                  className={cn(
                    'absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground',
                    taskSearchInput === defaultQuery && 'right-11 @max-[40rem]/rail-page:right-2'
                  )}
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>
          </RailPageSearch>
        </>
      }
      notices={
        pills.length > 0 || sourceNotices ? (
          <>
            {pills.length > 0 ? (
              <PRFilterPills pills={pills} onChange={applyPRFilterChange} />
            ) : null}
            {sourceNotices}
          </>
        ) : null
      }
    />
  )
}
