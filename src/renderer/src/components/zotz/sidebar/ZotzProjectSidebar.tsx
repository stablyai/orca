import React, { useCallback, useMemo, useState } from 'react'
import { FolderPlus, Plus } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { getAgentStatusEpochNow } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import { createLiveAgentWorktreeIdsSelector } from '@/lib/workspace/activity/worktree-activity-state'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { AddProjectMenu } from '../../sidebar/project-admission/menu/AddProjectMenu'
import type { AddRepoDialogEntryRequest } from '../../sidebar/project-admission/dialog/add-repo-dialog-types'
import { openHeaderCreateComposer } from '../../sidebar/worktree-list/rows/header-create-workspace-target'
import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  buildZotzFolderConversations,
  buildZotzProjectSections,
  type ZotzConversationRow
} from './zotz-project-conversations'

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

function ConversationRow({
  row,
  active,
  working
}: {
  row: ZotzConversationRow
  active: boolean
  working: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-current={active ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={() => activateAndRevealWorkspace(row.id)}
      className={cn(
        'flex w-full min-w-0 items-start gap-2 rounded-md py-1.5 pr-2 pl-8 text-left transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/80 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          working ? 'bg-agent-working' : 'bg-worktree-sidebar-foreground/25'
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{row.title}</span>
        {row.branch && row.branch !== row.title ? (
          <span className="block truncate font-mono text-2xs text-worktree-sidebar-foreground/50">
            {row.branch}
          </span>
        ) : null}
      </span>
    </button>
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
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)
  const agentStatusNow = getAgentStatusEpochNow(agentStatusEpoch)
  const [selectLiveAgentWorktreeIds] = useState(createLiveAgentWorktreeIdsSelector)
  const workingIds = useAppStore((s) =>
    selectLiveAgentWorktreeIds(s, s.tabsByWorktree, agentStatusNow)
  )

  const sections = useMemo(
    () => buildZotzProjectSections({ repos, worktreesByRepo, tabsByWorkspace: tabsByWorktree }),
    [repos, worktreesByRepo, tabsByWorktree]
  )
  const folders = useMemo(
    () => buildZotzFolderConversations({ folderWorkspaces, tabsByWorkspace: tabsByWorktree }),
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
              <ConversationRow
                key={row.id}
                row={row}
                active={row.id === activeWorktreeId}
                working={workingIds.has(row.id)}
              />
            ))}
          </section>
        ))}
        {folders.length > 0 ? (
          <section className="mb-2">
            <div className="px-2 py-1.5 text-sm font-semibold text-worktree-sidebar-foreground">
              {t('zotz.sidebar.folders', 'Folders')}
            </div>
            {folders.map((row) => (
              <ConversationRow
                key={row.id}
                row={row}
                active={row.id === activeWorktreeId}
                working={false}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  )
}
