import React, { useMemo, useState } from 'react'
import { ChevronDown, FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { useAppStore } from '@/store'
import type { LineageMember } from '../../../../../../shared/lineage-discovery-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { LineageOriginBadge } from '../../lineage-origin-badge'
import {
  LineagePullRequestRow,
  lineagePullRequestLabel
} from '../../lineage-members/LineagePullRequestRow'
import { useLineageMemberWorktreeResolver } from '../../lineage-members/use-lineage-member-worktree'
import { AddToTowerButton } from '../../lineage-members/AddToTowerDialog'
import { RemoveManualLinkButton } from '../../lineage-members/RemoveManualLinkButton'
import { SourceControlTargetProvider } from '../panel/source-control-target-worktree'
import { translate } from '@/i18n/i18n'

type LineageSourceControlSectionsProps = {
  members: LineageMember[]
  /** The original single-worktree Source Control panel, rendered once per member worktree. */
  PanelComponent: React.ComponentType
  /** Enables add and Remove; absent when the host cannot persist manual links. */
  parentWorkspaceKey?: string
  /** Called after a manual link is added or removed so members can be re-fetched. */
  onMembersChanged?: () => void
}

type ManualLinkActions = { parentWorkspaceKey: string; onChanged: () => void }

function ManualRemoveButton({
  member,
  actions
}: {
  member: LineageMember
  actions?: ManualLinkActions
}): React.JSX.Element | null {
  if (!actions || !member.manualLinkId) {
    return null
  }
  return (
    <RemoveManualLinkButton
      parentWorkspaceKey={actions.parentWorkspaceKey}
      linkId={member.manualLinkId}
      label={lineagePullRequestLabel(member)}
      onChanged={actions.onChanged}
    />
  )
}

type MemberEntry = { key: string; member: LineageMember; worktree: Worktree | null }

function rowKey(member: LineageMember): string {
  return member.manualLinkId ?? `${member.repoName}:${member.branch}:${member.pr?.number ?? ''}`
}

function LineageSourceControlSection({
  member,
  worktree,
  isOpen,
  onOpenChange,
  PanelComponent,
  actions
}: {
  member: LineageMember
  worktree: Worktree
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  PanelComponent: React.ComponentType
  actions?: ManualLinkActions
}): React.JSX.Element {
  const identity = getWorktreeGitIdentityDisplay(worktree)
  // why: the section holds this worktree's panel, so its checked-out branch wins over discovery's report
  const branchLabel =
    identity?.kind === 'branch'
      ? identity.branchName
      : (identity?.sourceControlLabel ?? member.branch)
  const tabVisible = useAppStore(
    (s) => s.rightSidebarOpen && s.rightSidebarTab === 'source-control'
  )
  return (
    <Collapsible
      open={isOpen}
      onOpenChange={onOpenChange}
      className="flex flex-col"
      data-testid={`lineage-source-control-section-${worktree.id}`}
    >
      <div className="flex items-center pl-1 pr-3 pt-1.5 pb-1">
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
              <span className="truncate text-xs font-semibold" title={member.repoName}>
                {member.repoName}
              </span>
              {branchLabel ? (
                <span
                  className="truncate text-[11px] font-normal text-muted-foreground"
                  title={branchLabel}
                >
                  {branchLabel}
                </span>
              ) : null}
              <LineageOriginBadge matchedBy={member.matchedBy} reasons={member.reasons} />
              {member.unverifiable ? (
                <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
                  {translate(
                    'auto.components.rightSidebar.lineageSourceControl.unverifiable',
                    'unverifiable'
                  )}
                </span>
              ) : null}
            </span>
          </Button>
        </CollapsibleTrigger>
        <ManualRemoveButton member={member} actions={actions} />
      </div>
      {/* invariant: Radix unmounts closed content, so a collapsed section runs no git status, compare or review polling */}
      <CollapsibleContent className="flex flex-col">
        <SourceControlTargetProvider worktree={worktree} isActive={isOpen && tabVisible}>
          <PanelComponent />
        </SourceControlTargetProvider>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One collapsible original Source Control panel per member worktree the tower opened. */
export function LineageSourceControlSections({
  members,
  PanelComponent,
  parentWorkspaceKey,
  onMembersChanged
}: LineageSourceControlSectionsProps): React.JSX.Element {
  const resolveWorktree = useLineageMemberWorktreeResolver()
  const [openByKey, setOpenByKey] = useState<Record<string, boolean>>({})

  const entries = useMemo(() => {
    const seen = new Set<string>()
    const resolved: MemberEntry[] = []
    // invariant: the tower's own worktree is always the first section; the rest keep member order
    const ordered = [...members].sort(
      (a, b) => Number(Boolean(b.isTower)) - Number(Boolean(a.isTower))
    )
    for (const member of ordered) {
      const worktree = resolveWorktree(member)
      const key = worktree ? worktree.id : rowKey(member)
      // why: lineage and pattern discovery can both report one worktree; it gets one section
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      resolved.push({ key, member, worktree })
    }
    return resolved
  }, [members, resolveWorktree])
  const firstSectionKey = entries.find((entry) => entry.worktree !== null)?.key
  const actions: ManualLinkActions | undefined = parentWorkspaceKey
    ? { parentWorkspaceKey, onChanged: onMembersChanged ?? (() => {}) }
    : undefined

  return (
    <TooltipProvider>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-sleek"
        data-testid="lineage-source-control-sections"
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
          {entries.map(({ key, member, worktree }) =>
            worktree ? (
              <LineageSourceControlSection
                key={key}
                member={member}
                worktree={worktree}
                isOpen={openByKey[key] ?? key === firstSectionKey}
                onOpenChange={(open) => setOpenByKey((current) => ({ ...current, [key]: open }))}
                PanelComponent={PanelComponent}
                actions={actions}
              />
            ) : (
              <LineagePullRequestRow
                key={key}
                member={member}
                testId={`lineage-source-control-pr-row-${member.manualLinkId ?? lineagePullRequestLabel(member)}`}
                trailing={<ManualRemoveButton member={member} actions={actions} />}
              />
            )
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
