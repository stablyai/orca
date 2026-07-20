import React, { useEffect, useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Plus, RefreshCw, SquareTerminal, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { missionMemberErrorKey } from '@/store/slices/missions'
import { formatMissionMemberError } from './mission-member-error-copy'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import WorktreeCard from './WorktreeCard'
import { ProjectGroupNameDialog } from './ProjectGroupNameDialog'
import { MissionDeleteDialog } from './MissionDeleteDialog'
import { MissionAddProjectsDialog } from './MissionAddProjectsDialog'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Mission } from '../../../../shared/types'

const missionCollapseKey = (missionId: string): string => `mission:${missionId}`

function MissionMemberRows({ mission }: { mission: Mission }): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const allWorktrees = useAllWorktrees()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const missionMemberErrors = useAppStore((s) => s.missionMemberErrors)
  const removeMissionMember = useAppStore((s) => s.removeMissionMember)
  const recreateMissionMemberWorktree = useAppStore((s) => s.recreateMissionMemberWorktree)

  const repoById = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const worktreeById = useMemo(
    () => new Map(allWorktrees.map((worktree) => [worktree.id, worktree])),
    [allWorktrees]
  )

  return (
    <div className="flex flex-col gap-0.5">
      {mission.members.map((member) => {
        const repo = repoById.get(member.repoId)
        const worktree = member.worktreeId ? worktreeById.get(member.worktreeId) : undefined
        if (worktree) {
          return (
            <WorktreeCard
              key={member.repoId}
              // Why: inside a mission the repo is the member's identity, so the
              // card title shows the repo name (legacy members were created
              // with the mission name) and the repo badge would repeat it.
              worktree={{ ...worktree, displayName: repo?.displayName ?? worktree.displayName }}
              repo={repo}
              isActive={activeWorktreeId === worktree.id}
              onActivate={() => setActiveWorktree(worktree.id)}
              nativeDragEnabled={false}
              flushSurface
              hideRepoBadge
            />
          )
        }
        const error = missionMemberErrors[missionMemberErrorKey(mission.id, member.repoId)]
        return (
          <div
            key={member.repoId}
            className="group/mission-member flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-worktree-sidebar-accent"
          >
            <span className="truncate">{repo?.displayName ?? member.repoId}</span>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground/70" title={error}>
              {error
                ? formatMissionMemberError(error)
                : translate('auto.components.sidebar.MissionList.280576fc92', 'Workspace missing')}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto shrink-0 text-muted-foreground"
              aria-label={translate('auto.components.sidebar.MissionList.d241d824cb', 'Recreate')}
              onClick={() => void recreateMissionMemberWorktree(mission.id, member.repoId)}
            >
              <RefreshCw className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-muted-foreground can-hover:opacity-0 transition-opacity group-hover/mission-member:opacity-100 group-focus-within/mission-member:opacity-100 focus-visible:opacity-100"
              aria-label={translate(
                'auto.components.sidebar.MissionList.edb3b75817',
                'Remove from mission'
              )}
              onClick={() => void removeMissionMember(mission.id, member.repoId, false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}

function MissionSection({
  mission,
  onRename,
  onDelete,
  onAddProjects
}: {
  mission: Mission
  onRename: (mission: Mission) => void
  onDelete: (mission: Mission) => void
  onAddProjects: (mission: Mission) => void
}): React.JSX.Element {
  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  const toggleCollapsedGroup = useAppStore((s) => s.toggleCollapsedGroup)
  const sessionWorkspace = useAppStore(
    (s) => s.folderWorkspaces.find((fw) => fw.missionId === mission.id) ?? null
  )
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const ensureMissionSession = useAppStore((s) => s.ensureMissionSession)
  const collapsed = collapsedGroups.has(missionCollapseKey(mission.id))
  const ensureRequestedRef = useRef(false)

  // Why: missions created before the sessionized row (or whose eager ensure
  // failed) get their session materialized on first render of the tab.
  useEffect(() => {
    if (sessionWorkspace || ensureRequestedRef.current) {
      return
    }
    ensureRequestedRef.current = true
    void ensureMissionSession(mission.id)
  }, [sessionWorkspace, ensureMissionSession, mission.id])

  const missionMenu = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground can-hover:opacity-0 transition-opacity group-hover/mission:opacity-100 group-focus-within/mission:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          aria-label={translate(
            'auto.components.sidebar.MissionList.955a21f262',
            'Mission options'
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onAddProjects(mission)}>
          {translate('auto.components.sidebar.MissionList.28833b5212', 'Add projects')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRename(mission)}>
          {translate('auto.components.sidebar.MissionList.d12c29d655', 'Rename')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(mission)}>
          {translate('auto.components.sidebar.MissionList.b32972019a', 'Delete mission')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  if (!sessionWorkspace) {
    // Fallback while the session materializes (or after an ensure failure):
    // clicking retries the ensure; members stay reachable underneath.
    return (
      <div data-mission-id={mission.id} className="group/mission flex flex-col">
        <div className="flex h-7 items-center gap-1 rounded-md px-1.5 hover:bg-worktree-sidebar-accent">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] text-muted-foreground"
            onClick={() => void ensureMissionSession(mission.id)}
          >
            <SquareTerminal className="size-3.5 shrink-0" />
            <span className="truncate">{mission.name}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground/60">
              {mission.members.length === 1
                ? translate('auto.components.sidebar.MissionList.83e2a3cc38', '1 project')
                : translate(
                    'auto.components.sidebar.MissionList.745def31cd',
                    '{{value0}} projects',
                    { value0: mission.members.length }
                  )}
            </span>
          </button>
          {missionMenu}
        </div>
        <MissionMemberRows mission={mission} />
      </div>
    )
  }

  const sessionWorktree = folderWorkspaceToWorktree(sessionWorkspace)
  return (
    <div data-mission-id={mission.id} className="group/mission relative">
      <WorktreeCard
        worktree={sessionWorktree}
        repo={undefined}
        isActive={activeWorktreeId === sessionWorktree.id}
        onActivate={() => setActiveWorktree(sessionWorktree.id)}
        nativeDragEnabled={false}
        flushSurface
        hideFolderPathLabel
        lineageChildCount={mission.members.length}
        lineageCollapsed={collapsed}
        onLineageToggle={(event) => {
          event.preventDefault()
          event.stopPropagation()
          toggleCollapsedGroup(missionCollapseKey(mission.id))
        }}
      />
      <div className="absolute right-1 top-1 z-10">{missionMenu}</div>
      {/* Why: members render OUTSIDE the session card so the card's click
          surface is exactly the mission row, not the whole nested block. */}
      {!collapsed && mission.members.length > 0 ? (
        <div className="pl-3 pt-0.5">
          <MissionMemberRows mission={mission} />
        </div>
      ) : null}
    </div>
  )
}

export default function MissionList(): React.JSX.Element {
  const missions = useAppStore((s) => s.missions)
  const openModal = useAppStore((s) => s.openModal)
  const renameMission = useAppStore((s) => s.renameMission)
  const [renaming, setRenaming] = useState<Mission | null>(null)
  const [deleting, setDeleting] = useState<Mission | null>(null)
  const [addingTo, setAddingTo] = useState<Mission | null>(null)

  if (missions.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
        <span className="text-[13px] font-medium text-muted-foreground">
          {translate('auto.components.sidebar.MissionList.c9de5b6d5a', 'No missions yet')}
        </span>
        <span className="text-xs text-muted-foreground/70">
          {translate(
            'auto.components.sidebar.MissionList.d5d9aa29fa',
            'Group projects per task. Each project gets a workspace on a shared mission branch.'
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="mt-1 text-xs"
          onClick={() => openModal('mission-create')}
        >
          <Plus className="size-3.5" />
          {translate('auto.components.sidebar.MissionList.e4cb2a2294', 'New Mission')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto worktree-sidebar-scrollbar px-1.5 pb-2">
      <div className="flex flex-col gap-1.5">
        {missions.map((mission) => (
          <MissionSection
            key={mission.id}
            mission={mission}
            onRename={setRenaming}
            onDelete={setDeleting}
            onAddProjects={setAddingTo}
          />
        ))}
      </div>
      <ProjectGroupNameDialog
        open={renaming !== null}
        title={translate('auto.components.sidebar.MissionList.d56fdff6c8', 'Rename Mission')}
        description=""
        nameLabel={translate('auto.components.sidebar.MissionList.8d3abfb48a', 'Mission Name')}
        initialName={renaming?.name ?? ''}
        confirmLabel={translate('auto.components.sidebar.MissionList.7f94e6c670', 'Save')}
        onOpenChange={(open) => {
          if (!open) {
            setRenaming(null)
          }
        }}
        onSubmit={async (name) => {
          if (renaming) {
            await renameMission(renaming.id, name)
          }
        }}
      />
      <MissionDeleteDialog mission={deleting} onOpenChange={(open) => !open && setDeleting(null)} />
      <MissionAddProjectsDialog
        mission={addingTo}
        onOpenChange={(open) => !open && setAddingTo(null)}
      />
    </div>
  )
}
