import { useMemo, useState } from 'react'
import { CircleDot, Github, Gitlab, GitPullRequest, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useActiveRepo } from '@/store/selectors'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'
import { getJiraPresets } from '@/components/task-page/task-page-localized-options'
import { getWorkItemRepo } from '@/lib/work-item-repo-row'
import {
  openComposerForGitHubWorkItem,
  openComposerForGitLabWorkItem,
  openComposerForJiraIssue
} from '@/components/task-page/work-item-workspace-composer'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { JiraIssue } from '../../../../shared/jira/jira-types'
import { getQuickTasksRepos } from './quick-tasks-repos'
import { QuickTaskRow, QuickTasksSection, QuickTasksToggle } from './QuickTasksList'
import { useQuickTasks, type QuickTasksJiraPreset, type QuickTasksKind } from './use-quick-tasks'

const QUICK_TASKS_JIRA_PRESETS: readonly QuickTasksJiraPreset[] = ['assigned', 'reported', 'all']

function isQuickTasksJiraPreset(value: string): value is QuickTasksJiraPreset {
  return QUICK_TASKS_JIRA_PRESETS.some((preset) => preset === value)
}

export default function QuickTasksPanel({
  isVisible = true
}: {
  isVisible?: boolean
}): React.JSX.Element {
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey ?? s.activeWorktreeId)
  const activeRepo = useActiveRepo()
  const folderWorkspaces = useAppStore((s) => selectFolderWorkspaces(s))
  const projectGroups = useAppStore((s) => s.projectGroups)
  const repos = useAppStore((s) => s.repos)
  const openModal = useAppStore((s) => s.openModal)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [githubKind, setGithubKind] = useState<QuickTasksKind>('issues')
  const [gitlabKind, setGitlabKind] = useState<QuickTasksKind>('issues')
  const [jiraPreset, setJiraPreset] = useState<QuickTasksJiraPreset>('assigned')

  const taskRepos = useMemo(
    () =>
      getQuickTasksRepos({
        activeWorkspaceKey,
        activeRepo,
        folderWorkspaces,
        projectGroups,
        repos
      }),
    [activeRepo, activeWorkspaceKey, folderWorkspaces, projectGroups, repos]
  )
  const { checking, github, gitlab, jira } = useQuickTasks({
    repos: taskRepos,
    githubKind,
    gitlabKind,
    jiraPreset,
    isVisible,
    refreshNonce
  })
  const issuesLabel = translate('auto.components.rightSidebar.QuickTasksPanel.issues', 'Issues')
  const emptyIssuesLabel = translate(
    'auto.components.rightSidebar.QuickTasksPanel.empty',
    'No open issues.'
  )
  const jiraPresetOptions = getJiraPresets().flatMap((preset) =>
    isQuickTasksJiraPreset(preset.id) ? [{ value: preset.id, label: preset.label }] : []
  )
  const showRepoName = taskRepos.length > 1
  const repoName = (repoId: string | undefined): string | null =>
    showRepoName && repoId
      ? (taskRepos.find((repo) => repo.id === repoId)?.displayName ?? null)
      : null

  const openGitHubItem = (item: GitHubWorkItem): void => {
    openTaskPage({
      taskSource: 'github',
      preselectedRepoId: item.repoId,
      openGitHubWorkItem: item,
      openGitHubSourceContext: getTaskPageRepoSourceContext(getWorkItemRepo(repos, item), 'github')
    })
  }
  const openGitLabItem = (item: GitLabWorkItem): void => {
    openTaskPage({
      taskSource: 'gitlab',
      preselectedRepoId: item.repoId,
      openGitLabWorkItem: item,
      openGitLabSourceContext: getTaskPageRepoSourceContext(
        getWorkItemRepo(repos, item),
        'gitlab',
        item.projectRef
      )
    })
  }
  const openJiraIssue = (issue: JiraIssue): void => {
    openTaskPage({ taskSource: 'jira', openJiraIssue: issue })
  }

  // Why: Jira is account-scoped, so it still has tasks to show without a git workspace.
  if (taskRepos.length === 0 && !jira.enabled) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {translate(
          'auto.components.rightSidebar.QuickTasksPanel.noRepos',
          'Open a git workspace to see its tasks here.'
        )}
      </div>
    )
  }

  const anyEnabled = github.enabled || gitlab.enabled || jira.enabled
  const noSource = !checking && !anyEnabled

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex items-center justify-end gap-2 border-b border-border px-4 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.rightSidebar.QuickTasksPanel.refresh',
                'Refresh'
              )}
              onClick={() => setRefreshNonce((value) => value + 1)}
            >
              <RefreshCw />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate('auto.components.rightSidebar.QuickTasksPanel.refresh', 'Refresh')}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        {checking && !anyEnabled ? (
          <div className="flex justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : noSource ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {translate(
              'auto.components.rightSidebar.QuickTasksPanel.noSource',
              'Sign in to GitHub, GitLab or Jira to see this project’s tasks.'
            )}
          </div>
        ) : null}

        {github.enabled ? (
          <QuickTasksSection
            icon={<Github className="size-3.5" />}
            label="GitHub"
            loading={github.loading}
            failed={github.failed}
            count={github.items.length}
            emptyLabel={
              githubKind === 'issues'
                ? emptyIssuesLabel
                : translate(
                    'auto.components.rightSidebar.QuickTasksPanel.emptyPullRequests',
                    'No open pull requests.'
                  )
            }
            toggle={
              <QuickTasksToggle
                value={githubKind}
                onChange={setGithubKind}
                options={[
                  { value: 'issues', label: issuesLabel },
                  {
                    value: 'reviews',
                    label: translate(
                      'auto.components.rightSidebar.QuickTasksPanel.pullRequests',
                      'PRs'
                    )
                  }
                ]}
              />
            }
          >
            {github.items.map((item) => (
              <QuickTaskRow
                key={`${item.repoId}:${item.id}`}
                icon={
                  item.type === 'pr' ? (
                    <GitPullRequest className="size-3.5" />
                  ) : (
                    <CircleDot className="size-3.5" />
                  )
                }
                reference={`#${item.number}`}
                title={item.title}
                repoName={repoName(item.repoId)}
                onOpen={() => openGitHubItem(item)}
                onCreateWorkspace={() => openComposerForGitHubWorkItem(repos, openModal, item)}
                onOpenExternal={() => void window.api.shell.openUrl(item.url)}
              />
            ))}
          </QuickTasksSection>
        ) : null}

        {gitlab.enabled ? (
          <QuickTasksSection
            icon={<Gitlab className="size-3.5" />}
            label="GitLab"
            loading={gitlab.loading}
            failed={gitlab.failed}
            count={gitlab.items.length}
            emptyLabel={
              gitlabKind === 'issues'
                ? emptyIssuesLabel
                : translate(
                    'auto.components.rightSidebar.QuickTasksPanel.emptyReviews',
                    'No open merge requests.'
                  )
            }
            toggle={
              <QuickTasksToggle
                value={gitlabKind}
                onChange={setGitlabKind}
                options={[
                  { value: 'issues', label: issuesLabel },
                  {
                    value: 'reviews',
                    label: translate(
                      'auto.components.rightSidebar.QuickTasksPanel.mergeRequests',
                      'MRs'
                    )
                  }
                ]}
              />
            }
          >
            {gitlab.items.map((item) => (
              <QuickTaskRow
                key={`${item.repoId}:${item.id}`}
                icon={
                  item.type === 'mr' ? (
                    <GitPullRequest className="size-3.5" />
                  ) : (
                    <CircleDot className="size-3.5" />
                  )
                }
                reference={`${item.type === 'mr' ? '!' : '#'}${item.number}`}
                title={item.title}
                repoName={repoName(item.repoId)}
                onOpen={() => openGitLabItem(item)}
                onCreateWorkspace={() => openComposerForGitLabWorkItem(repos, openModal, item)}
                onOpenExternal={() => void window.api.shell.openUrl(item.url)}
              />
            ))}
          </QuickTasksSection>
        ) : null}

        {jira.enabled ? (
          <QuickTasksSection
            icon={<JiraIcon className="size-3.5" />}
            label="Jira"
            loading={jira.loading}
            failed={jira.failed}
            count={jira.items.length}
            emptyLabel={translate(
              'auto.components.rightSidebar.QuickTasksPanel.emptyJira',
              'No matching issues.'
            )}
            toggle={
              <QuickTasksToggle
                value={jiraPreset}
                onChange={setJiraPreset}
                options={jiraPresetOptions}
              />
            }
          >
            {jira.items.map((issue) => (
              <QuickTaskRow
                key={`${issue.siteId ?? ''}:${issue.key}`}
                icon={<CircleDot className="size-3.5" />}
                reference={issue.key}
                title={issue.title}
                repoName={null}
                onOpen={() => openJiraIssue(issue)}
                onCreateWorkspace={() =>
                  openComposerForJiraIssue(openModal, issue, taskRepos[0]?.id)
                }
                onOpenExternal={() => void window.api.shell.openUrl(issue.url)}
              />
            ))}
          </QuickTasksSection>
        ) : null}
      </div>
    </div>
  )
}
