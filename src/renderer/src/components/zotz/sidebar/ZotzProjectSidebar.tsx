import React, { useCallback, useEffect, useMemo } from 'react'
import { FolderPlus, Plus } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import type { AgentDotState } from '@/components/AgentStateDot'
import { GitHubIcon } from '@/components/icons/GitHubIcon'
import { activityThreadStatusId } from '@/components/activity/activity-thread-presentation'
import { useAllAgentPaneThreads } from '@/components/activity/use-agent-pane-threads'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { AddProjectMenu } from '../../sidebar/project-admission/menu/AddProjectMenu'
import type { AddRepoDialogEntryRequest } from '../../sidebar/project-admission/dialog/add-repo-dialog-types'
import { openHeaderCreateComposer } from '../../sidebar/worktree-list/rows/header-create-workspace-target'
import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  buildZotzFolderConversations,
  buildZotzProjectSections,
  summarizeZotzConversationStatus,
  type ZotzConversationStatus
} from './zotz-project-conversations'
import { useZotzGitHubRepoIcons } from './use-zotz-github-repo-icons'
import { useZotzAgentQueue } from '../agent-queue/zotz-agent-queue-store'
import { ZotzConversationMenu } from './ZotzConversationMenu'
import { ZotzProjectMenu } from './ZotzProjectMenu'
import HiddenProjectsSection from '../../sidebar/hidden-projects/HiddenProjectsSection'
import { ZotzConversationRow } from './ZotzConversationRow'
import { ZotzArchivedSection } from './ZotzArchivedSection'

function AddProjectButton(): React.JSX.Element {
  const t = useTranslate()
  const openModal = useAppStore((s) => s.openModal)
  const label = t('auto.components.sidebar.SidebarHeader.addProject', 'Add project')
  const openEntryRequest = useCallback(
    (entryRequest: AddRepoDialogEntryRequest) => openModal('add-repo', { entryRequest }),
    [openModal]
  )
  return (
    <AddProjectMenu
      side="bottom"
      align="end"
      tooltipLabel={label}
      onOpenEntryRequest={openEntryRequest}
    >
      <Button variant="ghost" size="icon-xs" type="button" aria-label={label}>
        <FolderPlus className="size-3.5" />
      </Button>
    </AddProjectMenu>
  )
}

function ProjectHeader({ repo }: { repo: Repo }): React.JSX.Element {
  const t = useTranslate()
  const label = t('zotz.sidebar.newConversationIn', 'New conversation in {{project}}', {
    project: repo.displayName
  })
  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-worktree-sidebar-foreground/5">
      <RepoIconGlyph repoIcon={repo.repoIcon} className="size-5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-worktree-sidebar-foreground">
        {repo.displayName}
      </span>
      {repo.repoIcon?.type === 'image' && repo.repoIcon.source === 'github' ? (
        <GitHubIcon className="size-3.5 shrink-0 text-worktree-sidebar-foreground/40" />
      ) : null}
      <ZotzProjectMenu repo={repo} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={label}
            onClick={() => openHeaderCreateComposer(repo, { pinHost: true })}
          >
            <Plus className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/** Conductor-style sidebar: projects with "+", and under each only the conversations the user started. */
export default function ZotzProjectSidebar(): React.JSX.Element {
  const t = useTranslate()
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const folderWorkspaces = useAppStore((s) => selectFolderWorkspaces(s))
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const { allThreads } = useAllAgentPaneThreads()
  const statusByWorkspace = useMemo(() => {
    const threadsByWorkspace = new Map<string, { state: AgentDotState; unread: boolean }[]>()
    for (const thread of allThreads) {
      const list = threadsByWorkspace.get(thread.worktree.id) ?? []
      list.push({ state: activityThreadStatusId(thread), unread: thread.unread })
      threadsByWorkspace.set(thread.worktree.id, list)
    }
    const result = new Map<string, ZotzConversationStatus>()
    for (const [id, threads] of threadsByWorkspace) {
      const status = summarizeZotzConversationStatus(threads)
      if (status) {
        result.set(id, status)
      }
    }
    return result
  }, [allThreads])
  useZotzGitHubRepoIcons(repos)
  const queueSnapshot = useZotzAgentQueue()
  const canceledWorkspaces = useMemo(
    () => new Set(queueSnapshot.canceled.map((launch) => launch.label)),
    [queueSnapshot.canceled]
  )

  const sections = useMemo(
    () =>
      buildZotzProjectSections({
        repos,
        worktreesByRepoId: worktreesByRepo,
        workspacesWithAgents: new Set([...statusByWorkspace.keys(), ...canceledWorkspaces])
      }),
    [repos, worktreesByRepo, statusByWorkspace, canceledWorkspaces]
  )
  // Upstream refreshes PR status only for cards it reports as on screen; this list is the cards here.
  const setVisibleReviewIds = useAppStore((s) => s.setVisibleReviewCardWorktreeIds)
  const reviewIds = useMemo(
    () =>
      sections.flatMap(({ conversations }) =>
        conversations.flatMap((row) => (row.worktree?.branch ? [row.worktree.id] : []))
      ),
    [sections]
  )
  useEffect(() => {
    const publish = (): void =>
      setVisibleReviewIds(document.visibilityState === 'visible' ? reviewIds : [])
    publish()
    document.addEventListener('visibilitychange', publish)
    return () => {
      document.removeEventListener('visibilitychange', publish)
      setVisibleReviewIds([])
    }
  }, [reviewIds, setVisibleReviewIds])

  const folders = useMemo(
    () =>
      buildZotzFolderConversations({ folders: folderWorkspaces, tabsByWorkspace: tabsByWorktree }),
    [folderWorkspaces, tabsByWorktree]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-4 pt-2 pb-1">
        <span className="text-xs font-medium text-worktree-sidebar-foreground/60">
          {t('dashboard.sidebar.projects', 'Projects')}
        </span>
        <AddProjectButton />
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sections.length === 0 && folders.length === 0 ? (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {t('zotz.sidebar.empty', 'Add a project from GitHub or a local folder to start.')}
          </p>
        ) : null}
        {sections.map(({ repo, conversations }) => (
          <section key={repo.id} className="mb-2">
            <ProjectHeader repo={repo} />
            {conversations.map((row) => (
              <ZotzConversationMenu key={row.id} worktree={row.worktree}>
                <ZotzConversationRow
                  row={row}
                  repo={repo}
                  active={row.id === activeWorktreeId}
                  status={statusByWorkspace.get(row.id) ?? null}
                  canceled={canceledWorkspaces.has(row.id)}
                />
              </ZotzConversationMenu>
            ))}
          </section>
        ))}
        {folders.length > 0 ? (
          <section className="mb-2">
            <div className="px-2 py-1.5 text-sm font-semibold text-worktree-sidebar-foreground">
              {t('zotz.sidebar.folders', 'Folders')}
            </div>
            {folders.map((row) => (
              <ZotzConversationRow
                key={row.id}
                row={row}
                repo={undefined}
                active={row.id === activeWorktreeId}
                status={statusByWorkspace.get(row.id) ?? null}
                canceled={canceledWorkspaces.has(row.id)}
              />
            ))}
          </section>
        ) : null}
      </div>
      <ZotzArchivedSection />
      <HiddenProjectsSection />
    </div>
  )
}
