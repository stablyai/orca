import React from 'react'
import { LoaderCircle, Plus, RefreshCw, Search, X } from 'lucide-react'

import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import IssueSourceIndicator from '@/components/github/IssueSourceIndicator'
import IssueSourceSelector, { issueSourceChipClass } from '@/components/github/IssueSourceSelector'
import PRFilterDropdowns, { type PRFilterChange } from '@/components/github/PRFilterDropdowns'
import {
  getGitHubTaskKindPresets,
  type GitHubTaskKind
} from '@/components/task-page-localized-options'
import { resolveNewIssueOpenSeed } from '@/components/task-page-new-issue-draft'
import type { TaskPageRepoSourceState } from '@/components/task-page-cache-selectors'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../../shared/github/pull-request-types'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { IssueSourcePreference, Repo } from '../../../../../shared/repo-types'
import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { TaskResumeState, TaskViewPresetId } from '../../../../../shared/ui-chrome-types'
import {
  hasDivergentSources,
  hasUpstreamCandidateDivergence
} from '@/components/task-page/source/repo-source-divergence'

export type TaskPageGithubItemFiltersProps = {
  activeGithubTaskKind: GitHubTaskKind
  activeTaskPreset: TaskViewPresetId | null
  setTaskSearchInput: (value: string) => void
  setAppliedTaskSearch: (value: string) => void
  setActiveTaskPreset: (preset: TaskViewPresetId | null) => void
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  setTaskRefreshNonce: React.Dispatch<React.SetStateAction<number>>
  handleSetDefaultTaskPreset: (presetId: TaskViewPresetId) => void
  appliedTaskQuery: ParsedTaskQuery
  loadedGitHubAuthorLogins: string[]
  primaryGithubFilterSlug: GitHubOwnerRepo | null
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  applyPRFilterChange: (change: PRFilterChange) => void
  taskSearchInputRef: React.RefObject<HTMLInputElement | null>
  taskSearchInput: string
  handleTaskSearchChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  handleTaskSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
  appliedTaskSearch: string
  handleResetGithubTaskSearch: () => void
  selectedRepos: Repo[]
  setNewIssueTitle: (value: string) => void
  setNewIssueBody: (value: string) => void
  setNewIssueLabels: (labels: string[]) => void
  setNewIssueAssignees: (assignees: GitHubAssignableUser[]) => void
  setNewIssueRepoId: (repoId: string | null) => void
  setNewIssueOpen: (open: boolean) => void
  newIssueTargetRepo: Repo | null
  handleRefreshGithubTasks: () => void
  githubTasksBusy: boolean
  perRepoSourceState: TaskPageRepoSourceState[]
  setIssueSourcePreference: (
    repoId: string,
    repoPath: string,
    preference: IssueSourcePreference
  ) => Promise<void>
}

export function TaskPageGithubItemFilters({
  activeGithubTaskKind,
  activeTaskPreset,
  setTaskSearchInput,
  setAppliedTaskSearch,
  setActiveTaskPreset,
  setTaskResumeState,
  setTaskRefreshNonce,
  handleSetDefaultTaskPreset,
  appliedTaskQuery,
  loadedGitHubAuthorLogins,
  primaryGithubFilterSlug,
  settings,
  applyPRFilterChange,
  taskSearchInputRef,
  taskSearchInput,
  handleTaskSearchChange,
  handleTaskSearchKeyDown,
  appliedTaskSearch,
  handleResetGithubTaskSearch,
  selectedRepos,
  setNewIssueTitle,
  setNewIssueBody,
  setNewIssueLabels,
  setNewIssueAssignees,
  setNewIssueRepoId,
  setNewIssueOpen,
  newIssueTargetRepo,
  handleRefreshGithubTasks,
  githubTasksBusy,
  perRepoSourceState,
  setIssueSourcePreference
}: TaskPageGithubItemFiltersProps): React.JSX.Element {
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
                        ? { displayName: repo.displayName, color: repo.badgeColor }
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
