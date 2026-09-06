import type React from 'react'
import { Server, ServerOff } from 'lucide-react'
import { CommandItem } from '@/components/ui/command'
import { PaletteWorktreeStatusDot } from '@/components/cmd-j/palette-live-status'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { getPaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/worktree-default-display-name'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import {
  isPaletteCurrentWorktree,
  resolvePaletteRepoForWorktree
} from '@/lib/palette-repo-resolution'
import { formatPaletteSessionAge } from '@/components/cmd-j/palette-session-age'
import type { WorktreePaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import {
  getPaletteSupportingTextLabel,
  HighlightedText,
  PaletteHostBadgeChip
} from './worktree-jump-palette-primitives'

export function WorktreeJumpPaletteWorktreeRow({
  entry,
  renderKey,
  controller
}: {
  entry: WorktreePaletteItem
  renderKey: string
  controller: WorktreeJumpPaletteController
}): React.JSX.Element {
  const {
    repoMap,
    activeWorktreeId,
    sshConnectionStates,
    hostOptions,
    hostFilterActive,
    handleSelectItem
  } = controller
  const worktree = entry.worktree
  const repo = resolvePaletteRepoForWorktree(worktree, repoMap, controller.repoByHostIdentity)
  const repoName = repo?.displayName ?? ''
  const branch = resolveWorktreeBranchLabel(worktree)
  const worktreeLabel = resolveWorktreeDisplayName(worktree)
  const isCurrentWorktree = isPaletteCurrentWorktree(
    worktree,
    activeWorktreeId,
    controller.activeWorkspaceExecutionHostId
  )
  const sessionAge = formatPaletteSessionAge(worktree.lastActivityAt, controller.paletteNowMs)
  const sshConnectionId =
    repo?.connectionId && !isRuntimeOwnedSshTargetId(repo.connectionId) ? repo.connectionId : null
  const sshStatus = sshConnectionId
    ? (sshConnectionStates.get(sshConnectionId)?.status ?? 'disconnected')
    : null
  const isSshDisconnected = sshStatus != null && sshStatus !== 'connected'
  const hostBadge = getPaletteHostBadge(repo, hostOptions, hostFilterActive)

  return (
    <CommandItem
      value={renderKey}
      onSelect={() => handleSelectItem(entry)}
      data-current={isCurrentWorktree ? 'true' : undefined}
      className={cn(
        'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
        'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
      )}
    >
      <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start">
        <PaletteWorktreeStatusDot worktree={worktree} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              {sshConnectionId && (
                <span
                  aria-label={
                    isSshDisconnected
                      ? translate(
                          'auto.components.WorktreeJumpPalette.63c2be1914',
                          'SSH disconnected'
                        )
                      : translate('auto.components.WorktreeJumpPalette.34c8fbb46e', 'SSH remote')
                  }
                  className="shrink-0 inline-flex items-center"
                >
                  {isSshDisconnected ? (
                    <ServerOff className="size-3.5 text-red-400" aria-hidden="true" />
                  ) : (
                    <Server className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  )}
                </span>
              )}
              <span className="truncate text-[14px] font-semibold text-foreground">
                <HighlightedText text={worktreeLabel} matchRanges={entry.match.displayNameRanges} />
              </span>
              {sessionAge ? (
                <span
                  aria-label={translate(
                    'auto.components.WorktreeJumpPalette.lastActiveTime',
                    'Last active {{value0}} ago',
                    { value0: sessionAge }
                  )}
                  className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground/70"
                >
                  {sessionAge}
                </span>
              ) : null}
              {isCurrentWorktree && (
                <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                  {translate('auto.components.WorktreeJumpPalette.556e7232ca', 'Current')}
                </span>
              )}
              {worktree.isMainWorktree && (
                <span className="shrink-0 self-center rounded border border-muted-foreground/30 bg-muted-foreground/5 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground">
                  {translate('auto.components.WorktreeJumpPalette.739bda980c', 'primary')}
                </span>
              )}
              {branch.trim().length > 0 ? (
                <>
                  <span className="shrink-0 text-muted-foreground/45">·</span>
                  <span className="truncate text-[12px] font-medium text-muted-foreground/92">
                    <HighlightedText text={branch} matchRanges={entry.match.branchRanges} />
                  </span>
                </>
              ) : null}
            </div>
            {entry.match.supportingText && (
              <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[12px] leading-5 text-muted-foreground/88">
                <span className="inline-flex h-[18px] shrink-0 items-center rounded border border-border bg-foreground/[0.04] px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {getPaletteSupportingTextLabel(entry.match.supportingText.labelKind)}
                </span>
                <span className="truncate">
                  <HighlightedText
                    text={entry.match.supportingText.text}
                    matchRanges={entry.match.supportingText.matchRanges}
                  />
                </span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <PaletteHostBadgeChip badge={hostBadge} />
            {repoName && (
              <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                <RepoBadgeMark color={repo?.badgeColor} />
                <span className="truncate">
                  <HighlightedText text={repoName} matchRanges={entry.match.repoRanges} />
                </span>
              </span>
            )}
          </div>
        </div>
      </div>
    </CommandItem>
  )
}
