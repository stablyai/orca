import React, { useMemo } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { missionMemberErrorKey } from '@/store/slices/missions'
import type { Mission } from '../../../../shared/types'
import { formatMissionMemberError } from './mission-member-error-copy'
import WorktreeCard from './WorktreeCard'

export function MissionMemberRows({ mission }: { mission: Mission }): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const allWorktrees = useAllWorktrees()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const missionMemberErrors = useAppStore((s) => s.missionMemberErrors)
  const removeMissionMember = useAppStore((s) => s.removeMissionMember)
  const recreateMissionMemberWorktree = useAppStore((s) => s.recreateMissionMemberWorktree)
  const confirm = useConfirmationDialog()

  const removeMember = async (repoId: string, repoName: string, hasWorktree: boolean) => {
    if (hasWorktree) {
      const confirmed = await confirm({
        title: translate(
          'auto.components.sidebar.MissionMemberRows.2f310bd75a',
          'Remove project and delete workspace?'
        ),
        description: translate(
          'auto.components.sidebar.MissionMemberRows.539f206f0e',
          'This deletes the Mission workspace for {{value0}}. Git work that cannot be deleted safely is preserved on its branch.',
          { value0: repoName }
        ),
        confirmLabel: translate(
          'auto.components.sidebar.MissionMemberRows.1d08535a23',
          'Delete workspace'
        ),
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }
    }
    await removeMissionMember(mission.id, repoId, hasWorktree)
  }

  const repoById = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const worktreeById = useMemo(
    () => new Map(allWorktrees.map((worktree) => [worktree.id, worktree])),
    [allWorktrees]
  )

  return (
    <div className="flex flex-col gap-0.5">
      {mission.members.map((member) => {
        const repo = repoById.get(member.repoId)
        const candidate = member.worktreeId ? worktreeById.get(member.worktreeId) : undefined
        const worktree =
          candidate &&
          candidate.repoId === member.repoId &&
          member.worktreeInstanceId &&
          candidate.instanceId === member.worktreeInstanceId &&
          candidate.branch.replace(/^refs\/heads\//, '') === mission.branchName
            ? candidate
            : undefined
        const error =
          missionMemberErrors[missionMemberErrorKey(mission.id, member.repoId)] ??
          member.lastError ??
          undefined
        if (worktree) {
          return (
            <div key={member.repoId} className="group/mission-member min-w-0">
              <div className="flex min-w-0 items-center gap-1">
                <div className="min-w-0 flex-1">
                  <WorktreeCard
                    // Why: a Mission member's repo is its identity; the repo
                    // name replaces legacy Mission-named worktree titles.
                    worktree={{
                      ...worktree,
                      displayName: repo?.displayName ?? worktree.displayName
                    }}
                    repo={repo}
                    isActive={activeWorktreeId === worktree.id}
                    onActivate={() => setActiveWorktree(worktree.id)}
                    nativeDragEnabled={false}
                    flushSurface
                    hideRepoBadge
                    // Why: generic worktree mutations stay disabled; Mission
                    // lifecycle owns removal of its in-root checkout.
                    affiliateListMode
                  />
                </div>
                <RemoveMemberButton
                  onClick={() =>
                    void removeMember(member.repoId, repo?.displayName ?? member.repoId, true)
                  }
                />
              </div>
              {error ? (
                <p className="truncate px-2 pb-1 text-[11px] text-destructive" title={error}>
                  {formatMissionMemberError(error)}
                </p>
              ) : null}
            </div>
          )
        }
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
            <RemoveMemberButton
              onClick={() =>
                void removeMember(member.repoId, repo?.displayName ?? member.repoId, false)
              }
            />
          </div>
        )
      })}
    </div>
  )
}

function RemoveMemberButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="shrink-0 text-muted-foreground can-hover:opacity-0 transition-opacity group-hover/mission-member:opacity-100 group-focus-within/mission-member:opacity-100 focus-visible:opacity-100"
      aria-label={translate(
        'auto.components.sidebar.MissionList.edb3b75817',
        'Remove from mission'
      )}
      onClick={onClick}
    >
      <X className="size-3.5" />
    </Button>
  )
}
