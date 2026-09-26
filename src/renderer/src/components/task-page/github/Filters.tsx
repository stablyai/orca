import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { getGitHubTaskKindPresets } from '@/components/task-page-localized-options'
import { cn } from '@/lib/utils'
import PRFilterDropdowns from '@/components/github/PRFilterDropdowns'
import { Search, X, Plus, LoaderCircle, RefreshCw } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { resolveNewIssueOpenSeed } from '@/components/task-page-new-issue-draft'
import { useAppStore } from '@/store'
import { hasUpstreamCandidateDivergence, hasDivergentSources } from '../../task-page-draft-storage'
import IssueSourceIndicator from '@/components/github/IssueSourceIndicator'
import IssueSourceSelector, { issueSourceChipClass } from '@/components/github/IssueSourceSelector'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
export function TaskPageGitHubFilters({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    settings,
    setTaskResumeState,
    setIssueSourcePreference,
    selectedRepos,
    taskSearchInput,
    setTaskSearchInput,
    appliedTaskSearch,
    setAppliedTaskSearch,
    taskSearchInputRef,
    activeTaskPreset,
    setActiveTaskPreset,
    setTaskRefreshNonce,
    perRepoSourceState,
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
  return (
    // Why: top of the joined GitHub list card — pairs with the
    // table shell below (rounded-t-none border-t-0) as one surface.
    <div
      className="flex min-w-0 flex-col gap-2.5 rounded-md rounded-b-none border border-border/50 bg-muted/35 px-3 py-2.5"
      data-contextual-tour-target="tasks-search-presets"
    >
      <div className="flex flex-wrap gap-1.5">
        {getGitHubTaskKindPresets(activeGithubTaskKind).map((option) => {
          const active = activeTaskPreset === option.id
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                const query = option.query
                setTaskSearchInput(query)
                setAppliedTaskSearch(query)
                setActiveTaskPreset(option.id)
                setTaskResumeState({
                  githubItemsPreset: option.id,
                  githubItemsQuery: query
                })
                setTaskRefreshNonce((current) => current + 1)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                handleSetDefaultTaskPreset(option.id)
              }}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs font-medium transition',
                active
                  ? 'border-border/50 bg-foreground/90 text-background shadow-xs'
                  : 'border-border/60 bg-background text-foreground shadow-xs hover:bg-muted/60'
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <PRFilterDropdowns
          parsed={appliedTaskQuery}
          kind={activeGithubTaskKind}
          authorLogins={loadedGitHubAuthorLogins}
          primarySlug={primaryGithubFilterSlug}
          settings={settings}
          onChange={(change) => applyPRFilterChange(change)}
        />
        <div className="relative min-w-0 flex-1 basis-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={taskSearchInputRef}
            data-github-items-search-input
            value={taskSearchInput}
            onChange={handleTaskSearchChange}
            onKeyDown={handleTaskSearchKeyDown}
            placeholder={
              activeGithubTaskKind === 'prs'
                ? translate('auto.components.TaskPage.eee4df4c66', 'Search GitHub PRs...')
                : translate('auto.components.TaskPage.b15ceb409d', 'Search GitHub issues...')
            }
            className="h-8 rounded-md border-border/60 bg-background pl-8 pr-8 text-xs text-foreground shadow-xs"
          />
          {taskSearchInput || appliedTaskSearch ? (
            <button
              type="button"
              aria-label={translate('auto.components.TaskPage.b797bdd7c3', 'Clear search')}
              onClick={handleResetGithubTaskSearch}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        <div
          className="flex shrink-0 items-center gap-2"
          data-contextual-tour-target="tasks-actions"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
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
                disabled={!newIssueTargetRepo}
                aria-label={translate('auto.components.TaskPage.d3d0998b7d', 'New GitHub issue')}
                className="size-8 border-border/60 bg-background text-foreground shadow-xs hover:bg-muted/60"
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.d3d0998b7d', 'New GitHub issue')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={handleRefreshGithubTasks}
                disabled={githubTasksBusy}
                aria-busy={githubTasksBusy}
                aria-label={
                  githubTasksBusy
                    ? translate('auto.components.TaskPage.6ffa6be99f', 'Refreshing GitHub work')
                    : translate('auto.components.TaskPage.ff53631e6f', 'Refresh GitHub work')
                }
                className="size-8 cursor-pointer border-border/60 bg-background text-foreground shadow-xs hover:bg-muted/60 disabled:pointer-events-auto disabled:cursor-wait"
              >
                {githubTasksBusy ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {githubTasksBusy
                ? translate('auto.components.TaskPage.31f81cc334', 'Refreshing GitHub work…')
                : translate('auto.components.TaskPage.ff53631e6f', 'Refresh GitHub work')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {(() => {
        // Why: show the source-slug chip only when the selector can't render (no upstream to toggle); otherwise it duplicates the selector.
        const rows = perRepoSourceState.filter(
          (s) => hasUpstreamCandidateDivergence(s) || hasDivergentSources(s)
        )
        if (rows.length === 0) {
          return null
        }
        return (
          <div className="flex flex-wrap items-center gap-2">
            {rows.map((s) => {
              const repo = selectedRepos.find((r) => r.id === s.repoId)
              const showRepoBadgeLabel = selectedRepos.length > 1 && repo
              const selectorRenderable = hasUpstreamCandidateDivergence(s)
              // Why: render the indicator standalone — it has its own chip styles, so nesting it in our chip would double-border it.
              if (!selectorRenderable && hasDivergentSources(s)) {
                return (
                  <IssueSourceIndicator
                    key={s.repoId}
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
              // Why: <div> not <span> — the child selector renders a block <div> (div-in-span is invalid HTML); inline-flex class looks identical.
              return (
                <div key={s.repoId} className={issueSourceChipClass}>
                  {showRepoBadgeLabel ? (
                    <RepoBadgeLabel
                      name={repo.displayName}
                      color={repo.badgeColor}
                      badgeClassName="size-1.5"
                      className="text-[10px] text-muted-foreground"
                    />
                  ) : null}
                  <IssueSourceSelector
                    preference={repo.issueSourcePreference}
                    origin={s.sources.originCandidate}
                    upstream={s.sources.upstreamCandidate}
                    onChange={(next) => {
                      void setIssueSourcePreference(repo.id, repo.path, next)
                    }}
                  />
                </div>
              )
            })}
          </div>
        )
      })()}
    </div>
  )
}
