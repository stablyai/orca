import React, { useMemo, useState } from 'react'
import { ChevronDown, FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { LineageMember } from '../../../../../shared/lineage-discovery-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { LineageOriginBadge } from '../lineage-origin-badge'
import { AddToTowerButton } from '../lineage-members/AddToTowerDialog'
import { RemoveManualLinkButton } from '../lineage-members/RemoveManualLinkButton'
import {
  LineagePullRequestRow as SharedLineagePullRequestRow,
  lineagePullRequestLabel as pullRequestLabel,
  lineagePullRequestNumberLabel as pullRequestNumberLabel
} from '../lineage-members/LineagePullRequestRow'
import { useLineageMemberWorktreeResolver } from '../lineage-members/use-lineage-member-worktree'
import { ChecksPanelTargetProvider } from './checks-panel-target-worktree'

type LineageChecksSectionsProps = {
  members: LineageMember[]
  /** The original single-worktree Checks panel, rendered once per member worktree. */
  PanelComponent: React.ComponentType
  /** Enables add and Remove; absent when the host cannot persist manual links. */
  parentWorkspaceKey?: string
  /** Called after a manual link is added or removed so members can be re-fetched. */
  onMembersChanged?: () => void
}

type ManualLinkActions = { parentWorkspaceKey: string; onChanged: () => void }

type ResolvedMember = { member: LineageMember; worktree: Worktree | null }
type RepoGroup = {
  repoName: string
  entries: ResolvedMember[]
  hasWorktree: boolean
}

function groupByRepo(
  members: LineageMember[],
  resolveWorktree: (member: LineageMember) => Worktree | null
): RepoGroup[] {
  const groups = new Map<string, RepoGroup>()
  for (const member of members) {
    const worktree = resolveWorktree(member)
    const group = groups.get(member.repoName) ?? {
      repoName: member.repoName,
      entries: [],
      hasWorktree: false
    }
    group.entries.push({ member, worktree })
    group.hasWorktree = group.hasWorktree || worktree !== null
    groups.set(member.repoName, group)
  }
  return [...groups.values()]
}

function ManualRemoveButton({
  member,
  actions
}: {
  member: LineageMember
  actions?: ManualLinkActions
}): React.JSX.Element | null {
  if (!actions || member.matchedBy !== 'manual' || !member.manualLinkId) {
    return null
  }
  return (
    <RemoveManualLinkButton
      parentWorkspaceKey={actions.parentWorkspaceKey}
      linkId={member.manualLinkId}
      label={pullRequestLabel(member)}
      onChanged={actions.onChanged}
    />
  )
}

function LineagePullRequestRow({
  member,
  actions
}: {
  member: LineageMember
  actions?: ManualLinkActions
}): React.JSX.Element {
  return (
    <SharedLineagePullRequestRow
      member={member}
      testId={`lineage-checks-pr-row-${member.repoName}-${member.pr?.number ?? member.branch}`}
      trailing={<ManualRemoveButton member={member} actions={actions} />}
    />
  )
}

function LineageChecksSection({
  group,
  isOpen,
  onOpenChange,
  PanelComponent,
  actions
}: {
  group: RepoGroup
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  PanelComponent: React.ComponentType
  actions?: ManualLinkActions
}): React.JSX.Element {
  const lead = group.entries.find((entry) => entry.worktree !== null) ?? group.entries[0]
  const pr = group.entries.find((entry) => entry.member.pr)?.member.pr
  const worktreeCount = group.entries.filter((entry) => entry.worktree !== null).length
  return (
    <Collapsible
      open={isOpen}
      onOpenChange={onOpenChange}
      className="flex flex-col"
      data-testid={`lineage-checks-section-${group.repoName}`}
    >
      <div className="flex items-center gap-1 pl-1 pr-3 pt-1.5 pb-1">
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="min-w-0 flex-1 justify-start text-left"
          >
            <span className="flex min-w-0 flex-1 items-center gap-x-1.5 font-semibold">
              <ChevronDown
                className={cn(
                  'size-3.5 shrink-0 text-muted-foreground transition-transform',
                  !isOpen && '-rotate-90'
                )}
              />
              <FolderGit2 className="size-4 shrink-0 text-primary" />
              <span className="truncate text-xs font-semibold" title={group.repoName}>
                {group.repoName}
              </span>
              <LineageOriginBadge matchedBy={lead.member.matchedBy} reasons={lead.member.reasons} />
              {lead.member.branch ? (
                <span className="truncate text-[11px] font-normal text-muted-foreground">
                  ({lead.member.branch})
                </span>
              ) : null}
              {pr ? (
                <span className="ml-auto shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                  {pullRequestNumberLabel(pr)}
                </span>
              ) : null}
            </span>
          </Button>
        </CollapsibleTrigger>
        {worktreeCount <= 1 ? <ManualRemoveButton member={lead.member} actions={actions} /> : null}
      </div>
      {/* invariant: Radix unmounts closed content, so a collapsed section runs no panel fetches or polling */}
      <CollapsibleContent className="flex flex-col">
        {group.entries.map(({ member, worktree }) =>
          worktree ? (
            <div key={worktree.id} className="flex flex-col">
              {worktreeCount > 1 ? (
                <div className="flex items-center gap-1 pl-4 pr-3 pt-1 text-[11px] text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{member.branch}</span>
                  <ManualRemoveButton member={member} actions={actions} />
                </div>
              ) : null}
              <ChecksPanelTargetProvider worktree={worktree} isActive={isOpen}>
                <PanelComponent />
              </ChecksPanelTargetProvider>
            </div>
          ) : (
            <LineagePullRequestRow
              key={member.manualLinkId ?? pullRequestLabel(member)}
              member={member}
              actions={actions}
            />
          )
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function LineageChecksSections({
  members,
  PanelComponent,
  parentWorkspaceKey,
  onMembersChanged
}: LineageChecksSectionsProps): React.JSX.Element {
  const resolveWorktree = useLineageMemberWorktreeResolver()
  const [openByRepo, setOpenByRepo] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => groupByRepo(members, resolveWorktree), [members, resolveWorktree])
  const actions: ManualLinkActions | undefined = parentWorkspaceKey
    ? { parentWorkspaceKey, onChanged: onMembersChanged ?? (() => {}) }
    : undefined
  const firstSectionRepo = groups.find((group) => group.hasWorktree)?.repoName

  return (
    <TooltipProvider>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-sleek"
        data-testid="lineage-checks-sections"
      >
        {actions ? (
          <div className="flex justify-end px-3 pt-1.5">
            <AddToTowerButton
              parentWorkspaceKey={actions.parentWorkspaceKey}
              onChanged={actions.onChanged}
            />
          </div>
        ) : null}
        <div className="flex flex-col divide-y divide-border/40">
          {groups.map((group) =>
            group.hasWorktree ? (
              <LineageChecksSection
                key={group.repoName}
                group={group}
                isOpen={openByRepo[group.repoName] ?? group.repoName === firstSectionRepo}
                onOpenChange={(open) =>
                  setOpenByRepo((current) => ({
                    ...current,
                    [group.repoName]: open
                  }))
                }
                PanelComponent={PanelComponent}
                actions={actions}
              />
            ) : (
              group.entries.map(({ member }) => (
                <LineagePullRequestRow
                  key={member.manualLinkId ?? pullRequestLabel(member)}
                  member={member}
                  actions={actions}
                />
              ))
            )
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
