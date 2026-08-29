import React from 'react'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import TaskProjectSourceCombobox from '@/components/task-project-source-combobox'
import { normalizeTaskRepoSelection } from '@/components/task-page-default-repo-selection'
import type { TaskProjectPickerGroup } from '@/components/task-page-default-repo-selection'
import type { GitHubModeButton, GitHubTaskKind } from '@/components/task-page-localized-options'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskResumeState } from '../../../../../shared/ui-chrome-types'

export type TaskPageGithubModeBarProps = {
  projectModeVisible: boolean
  githubModeButtons: GitHubModeButton[]
  githubMode: 'items' | 'project'
  activeGithubTaskKind: GitHubTaskKind
  setGithubMode: (mode: 'items' | 'project') => void
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  handleSelectGithubTaskKind: (kind: GitHubTaskKind) => void
  taskPickerGroups: TaskProjectPickerGroup[]
  repoSelection: ReadonlySet<string>
  getTaskPickerRepoHostLabel: (repo: Repo) => string | null | undefined
  eligibleRepos: Repo[]
  setRepoSelection: (next: Set<string>) => void
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  taskPickerRepos: Repo[]
  selectedGitHubRepoExternalLink: { url: string; label: string } | null
}

export function TaskPageGithubModeBar({
  projectModeVisible,
  githubModeButtons,
  githubMode,
  activeGithubTaskKind,
  setGithubMode,
  setTaskResumeState,
  handleSelectGithubTaskKind,
  taskPickerGroups,
  repoSelection,
  getTaskPickerRepoHostLabel,
  eligibleRepos,
  setRepoSelection,
  updateSettings,
  taskPickerRepos,
  selectedGitHubRepoExternalLink
}: TaskPageGithubModeBarProps): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {projectModeVisible ? (
        <div className="flex items-center gap-1 text-xs">
          {githubModeButtons.map((mode) => {
            const active =
              mode.id === 'project'
                ? githubMode === 'project'
                : githubMode === 'items' && activeGithubTaskKind === mode.id
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => {
                  if (mode.id === 'project') {
                    setGithubMode('project')
                    setTaskResumeState({ githubMode: 'project' })
                    return
                  }
                  setGithubMode('items')
                  setTaskResumeState({ githubMode: 'items' })
                  handleSelectGithubTaskKind(mode.id)
                }}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs font-medium transition',
                  active
                    ? 'border-border/50 bg-foreground/90 text-background shadow-xs'
                    : 'border-border/60 bg-muted/50 text-foreground shadow-xs hover:bg-muted/70'
                )}
              >
                {mode.label}
              </button>
            )
          })}
        </div>
      ) : null}
      {/* Why: Project rows are repo-scoped, so the selection must stay visible in both GitHub modes. */}
      <div className="min-w-0 max-w-[220px] shrink-0">
        <TaskProjectSourceCombobox
          groups={taskPickerGroups}
          selected={repoSelection}
          getRepoHostLabel={getTaskPickerRepoHostLabel}
          onChange={(next) => {
            const normalized = normalizeTaskRepoSelection(eligibleRepos, next)
            setRepoSelection(normalized)
            void updateSettings({ defaultRepoSelection: [...normalized] }).catch(() => {
              toast.error(
                translate(
                  'auto.components.TaskPage.dfd72673e7',
                  'Failed to save project selection.'
                )
              )
            })
          }}
          onSelectAll={() => {
            const allIds = new Set(taskPickerRepos.map((r) => r.id))
            setRepoSelection(allIds)
            void updateSettings({ defaultRepoSelection: null }).catch(() => {
              toast.error(
                translate(
                  'auto.components.TaskPage.dfd72673e7',
                  'Failed to save project selection.'
                )
              )
            })
          }}
          triggerClassName="h-8 w-auto max-w-[220px] rounded-md border border-border/50 bg-muted/50 px-2 text-xs font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none"
        />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => {
              if (!selectedGitHubRepoExternalLink?.url) {
                return
              }
              void window.api.shell.openUrl(selectedGitHubRepoExternalLink.url)
            }}
            disabled={!selectedGitHubRepoExternalLink}
            aria-label={
              selectedGitHubRepoExternalLink
                ? translate('auto.components.TaskPage.8d1e17a3ef', 'Open {{value0}} in GitHub', {
                    value0: selectedGitHubRepoExternalLink.label
                  })
                : translate(
                    'auto.components.TaskPage.d1132848f8',
                    'Select one GitHub project to open in GitHub'
                  )
            }
            className="h-8 w-8 rounded-md border-border/50 bg-muted/50 text-foreground shadow-sm transition hover:bg-muted/50"
          >
            <ExternalLink className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {selectedGitHubRepoExternalLink
            ? translate('auto.components.TaskPage.8d1e17a3ef', 'Open {{value0}} in GitHub', {
                value0: selectedGitHubRepoExternalLink.label
              })
            : translate(
                'auto.components.TaskPage.bc46d8204e',
                'Select one project to open in GitHub'
              )}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
