import { useMemo, useState } from 'react'
import {
  CircleDot,
  ExternalLink,
  Github,
  Gitlab,
  GitPullRequest,
  LoaderCircle,
  Plus,
  RefreshCw
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useActiveRepo } from '@/store/selectors'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { getTaskPageRepoSourceContext } from '@/components/task-page-source-context'
import { getWorkItemRepo } from '@/lib/work-item-repo-row'
import {
  openComposerForGitHubWorkItem,
  openComposerForGitLabWorkItem
} from '@/components/work-item-workspace-composer'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import { getQuickTasksRepos } from './quick-tasks-repos'
import { useQuickTasks } from './use-quick-tasks'

type QuickTaskRowProps = {
  icon: React.ReactNode
  number: number
  title: string
  repoName: string | null
  onOpen: () => void
  onCreateWorkspace: () => void
  onOpenExternal: () => void
}

function QuickTaskRow({
  icon,
  number,
  title,
  repoName,
  onOpen,
  onCreateWorkspace,
  onOpenExternal
}: QuickTaskRowProps): React.JSX.Element {
  return (
    <div className="group flex items-start gap-2 px-3 py-1.5 hover:bg-accent/50">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
        onClick={onOpen}
      >
        <span className="mt-0.5 flex-none text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm text-foreground">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">
            #{number}
            {repoName ? ` · ${repoName}` : ''}
          </span>
        </span>
      </button>
      <div className="flex flex-none items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.rightSidebar.QuickTasksPanel.createWorkspace',
                'Create workspace'
              )}
              onClick={onCreateWorkspace}
            >
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate(
              'auto.components.rightSidebar.QuickTasksPanel.createWorkspace',
              'Create workspace'
            )}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate(
                'auto.components.rightSidebar.QuickTasksPanel.openInBrowser',
                'Open in browser'
              )}
              onClick={onOpenExternal}
            >
              <ExternalLink />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate(
              'auto.components.rightSidebar.QuickTasksPanel.openInBrowser',
              'Open in browser'
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

function QuickTasksSection({
  icon,
  label,
  loading,
  failed,
  count,
  children
}: {
  icon: React.ReactNode
  label: string
  loading: boolean
  failed: boolean
  count: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="py-1">
      <div className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-muted-foreground">
        {icon}
        <span className="flex-1">{label}</span>
        {loading ? <LoaderCircle className="size-3 animate-spin" /> : null}
      </div>
      {failed ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.rightSidebar.QuickTasksPanel.loadFailed',
            'Could not load tasks.'
          )}
        </div>
      ) : !loading && count === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {translate('auto.components.rightSidebar.QuickTasksPanel.empty', 'No open issues.')}
        </div>
      ) : (
        children
      )}
    </section>
  )
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
  const { checking, github, gitlab } = useQuickTasks({
    repos: taskRepos,
    isVisible,
    refreshNonce
  })
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

  if (taskRepos.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {translate(
          'auto.components.rightSidebar.QuickTasksPanel.noRepos',
          'Open a git workspace to see its tasks here.'
        )}
      </div>
    )
  }

  const noSource = !checking && !github.enabled && !gitlab.enabled

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {translate('auto.components.rightSidebar.QuickTasksPanel.title', 'Open issues')}
        </div>
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
        {checking && !github.enabled && !gitlab.enabled ? (
          <div className="flex justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : noSource ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {translate(
              'auto.components.rightSidebar.QuickTasksPanel.noSource',
              'Sign in to GitHub or GitLab to see this project’s issues.'
            )}
          </div>
        ) : null}

        {gitlab.enabled ? (
          <QuickTasksSection
            icon={<Gitlab className="size-3.5" />}
            label="GitLab"
            loading={gitlab.loading}
            failed={gitlab.failed}
            count={gitlab.items.length}
          >
            {gitlab.items.map((item) => (
              <QuickTaskRow
                key={`${item.repoId}:${item.id}`}
                icon={<CircleDot className="size-3.5" />}
                number={item.number}
                title={item.title}
                repoName={repoName(item.repoId)}
                onOpen={() => openGitLabItem(item)}
                onCreateWorkspace={() => openComposerForGitLabWorkItem(repos, openModal, item)}
                onOpenExternal={() => void window.api.shell.openUrl(item.url)}
              />
            ))}
          </QuickTasksSection>
        ) : null}

        {github.enabled ? (
          <QuickTasksSection
            icon={<Github className="size-3.5" />}
            label="GitHub"
            loading={github.loading}
            failed={github.failed}
            count={github.items.length}
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
                number={item.number}
                title={item.title}
                repoName={repoName(item.repoId)}
                onOpen={() => openGitHubItem(item)}
                onCreateWorkspace={() => openComposerForGitHubWorkItem(repos, openModal, item)}
                onOpenExternal={() => void window.api.shell.openUrl(item.url)}
              />
            ))}
          </QuickTasksSection>
        ) : null}
      </div>
    </div>
  )
}
