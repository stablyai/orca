import React from 'react'
import { AlertCircle, Server, ServerOff, Star, Trash2 } from 'lucide-react'

import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { Repo } from '../../../../shared/types'
import { resolveRepoHeaderColor } from './project-header-color'
import { formatSparseDirectoryPreview, shouldBeginWorktreeRename } from './worktree-card-model'
import type { WorktreeCardPresentation } from './worktree-card-presentation'
import { WorktreeCardSshHostControl } from './WorktreeCardSshHostControl'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'
import type { WorktreeCardController } from './use-worktree-card-controller'

// Why: pinned repo icon and compact inline badge share this chip shell so both repo cues read as the same affordance.
function RepoIdentityChip({
  repo,
  children
}: {
  repo: Repo
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-worktree-sidebar-border bg-worktree-sidebar-accent/55"
          aria-label={translate(
            'auto.components.sidebar.WorktreeCard.35ccfe2475',
            'Project {{value0}}',
            { value0: repo.displayName }
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {repo.displayName}
      </TooltipContent>
    </Tooltip>
  )
}

export function WorktreeCardHeader({
  card,
  presentation
}: {
  card: WorktreeCardController
  presentation: WorktreeCardPresentation
}): React.JSX.Element {
  const {
    worktree,
    repo,
    affiliateListMode,
    renameRowKey,
    compactCards,
    newCardStyle,
    parsedRepoHost,
    sshTargetLabel,
    sshStatus,
    sshTargetRemoved,
    sshOwnerEnvironmentId,
    stopQuickActionPointerPropagation,
    isRuntimeDisconnected,
    runtimeHostLabel,
    visibleCardTitle,
    isDeleting,
    showUnreadEmphasis,
    setTitleRenaming,
    handleRenameTitle,
    renamingWorktreeId,
    setRenamingWorktreeId,
    titleRenaming,
    handleOpenRenameErrorDialog,
    isFolder,
    handleWorkspaceQuickAction
  } = card
  const {
    showPinnedRepoIcon,
    showInlineRepoBadge,
    showHeaderActions,
    showTitleRowPrimary,
    showDeleteQuickAction,
    showTitleRowIndicators,
    titleRowIndicators,
    titleWrapper
  } = presentation

  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {showPinnedRepoIcon && (
          <RepoIdentityChip repo={repo!}>
            <RepoIconGlyph
              repoIcon={repo!.repoIcon}
              color={resolveRepoHeaderColor(repo!.badgeColor)}
              className="size-full"
              iconClassName="size-3"
            />
          </RepoIdentityChip>
        )}

        {repo?.connectionId && (
          <WorktreeCardSshHostControl
            targetId={repo.connectionId}
            targetLabel={sshTargetLabel || repo.displayName}
            status={sshStatus}
            targetRemoved={sshTargetRemoved}
            sshOwnerEnvironmentId={sshOwnerEnvironmentId}
            iconOnly={compactCards || newCardStyle}
            onPointerDown={stopQuickActionPointerPropagation}
          />
        )}

        {!repo?.connectionId && parsedRepoHost?.kind === 'runtime' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 inline-flex items-center">
                {isRuntimeDisconnected ? (
                  // Passive by design: runtime ("Orca server") hosts have no
                  // renderer-reachable connect API, unlike the SSH glyph above which is
                  // now a control. Don't "fix" the inconsistency by wiring one up.
                  <ServerOff className="size-3 text-destructive" />
                ) : (
                  <Server className="size-3 text-muted-foreground" />
                )}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {isRuntimeDisconnected
                ? runtimeHostLabel
                  ? translate(
                      'auto.components.sidebar.WorktreeCard.runtimeHostDisconnectedNamed',
                      '{{hostName}} disconnected',
                      { hostName: runtimeHostLabel }
                    )
                  : translate(
                      'auto.components.sidebar.WorktreeCard.runtimeHostDisconnected',
                      'Server disconnected'
                    )
                : runtimeHostLabel
                  ? translate(
                      'auto.components.sidebar.WorktreeCard.runtimeHostProjectNamed',
                      'Project on {{hostName}}',
                      { hostName: runtimeHostLabel }
                    )
                  : translate(
                      'auto.components.sidebar.WorktreeCard.runtimeHostProject',
                      'Project on Orca server'
                    )}
            </TooltipContent>
          </Tooltip>
        )}

        {showInlineRepoBadge && (
          <RepoIdentityChip repo={repo!}>
            <RepoIconGlyph
              repoIcon={repo!.repoIcon}
              color={resolveRepoHeaderColor(repo!.badgeColor)}
              className="size-full"
              iconClassName="size-3"
            />
          </RepoIdentityChip>
        )}

        {/* Why: unread alert lives in the left status lane; title-row contrast comes from weight and dimmed read titles. */}
        <WorktreeTitleInlineRename
          displayName={visibleCardTitle}
          disabled={isDeleting || affiliateListMode}
          showUnreadEmphasis={showUnreadEmphasis}
          dimReadTitle={newCardStyle}
          className="text-[13px] leading-5"
          editingClassName="flex-1"
          titleWrapper={titleWrapper}
          onEditingChange={affiliateListMode ? undefined : setTitleRenaming}
          onRename={handleRenameTitle}
          beginEditing={
            !affiliateListMode &&
            shouldBeginWorktreeRename(renamingWorktreeId, worktree.id, renameRowKey)
          }
          onBeginEditingConsumed={affiliateListMode ? undefined : () => setRenamingWorktreeId(null)}
        />

        {typeof worktree.firstAgentMessageRenameError === 'string' &&
        worktree.firstAgentMessageRenameError.length > 0 &&
        !titleRenaming ? (
          // Why: the error can be raw agent CLI output, so the badge opens a dialog rather than a tooltip.
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                onPointerDown={stopQuickActionPointerPropagation}
                onClick={handleOpenRenameErrorDialog}
                onDoubleClick={handleOpenRenameErrorDialog}
                className="h-4 shrink-0 gap-0.5 rounded !px-0.5 text-[10px] font-medium leading-none text-destructive border border-destructive/40 bg-destructive/10 hover:bg-destructive/15 hover:text-destructive has-[>svg]:!px-0.5"
                aria-label={translate(
                  'auto.components.sidebar.WorktreeCard.02e19349f4',
                  'Auto-rename failed: view error'
                )}
              >
                <AlertCircle className="size-2.5" />
                {translate('auto.components.sidebar.WorktreeCard.74522ee457', 'rename failed')}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {translate(
                'auto.components.sidebar.WorktreeCard.4eba2ea99e',
                'Auto-name failed. Click to see details.'
              )}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {!compactCards && worktree.isMainWorktree && !isFolder && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-foreground/70 border-foreground/20 bg-foreground/[0.06]"
              >
                {translate('auto.components.sidebar.WorktreeCard.7d517f82e2', 'primary')}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {translate(
                'auto.components.sidebar.WorktreeCard.0777de5970',
                'Primary worktree (original clone directory)'
              )}
            </TooltipContent>
          </Tooltip>
        )}

        {worktree.isSparse && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className="h-[16px] px-1.5 text-[10px] font-medium rounded shrink-0 leading-none text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/5"
              >
                {translate('auto.components.sidebar.WorktreeCard.4f964d5e8c', 'sparse')}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8} className="max-w-72">
              <div className="space-y-1">
                <div>
                  {translate(
                    'auto.components.sidebar.WorktreeCard.0f33af979b',
                    'Partial checkout. Files outside these paths are not on disk.'
                  )}
                </div>
                {worktree.sparseDirectories && worktree.sparseDirectories.length > 0 ? (
                  <div className="font-mono text-[11px] opacity-80">
                    {formatSparseDirectoryPreview(worktree.sparseDirectories)}
                  </div>
                ) : null}
              </div>
            </TooltipContent>
          </Tooltip>
        )}

        {showTitleRowIndicators && titleRowIndicators}
      </div>

      {showHeaderActions && (
        <div className="ml-auto flex shrink-0 items-center justify-center gap-1 pr-1.5">
          {showTitleRowPrimary && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="shrink-0 inline-flex items-center"
                  aria-label={translate(
                    'auto.components.sidebar.WorktreeCard.0d224eff10',
                    'Primary worktree'
                  )}
                >
                  <Star className="size-3 fill-amber-400 text-amber-400" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {translate(
                  'auto.components.sidebar.WorktreeCard.0777de5970',
                  'Primary worktree (original clone directory)'
                )}
              </TooltipContent>
            </Tooltip>
          )}

          {showDeleteQuickAction && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-workspace-board-preserve-open=""
                  onPointerDown={stopQuickActionPointerPropagation}
                  onClick={handleWorkspaceQuickAction}
                  className={cn(
                    'inline-flex size-4 items-center justify-center rounded bg-transparent opacity-0 transition-colors transition-opacity',
                    'group-hover/worktree-card:opacity-100 group-focus-within/worktree-card:opacity-100 focus-visible:opacity-100',
                    'text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive'
                  )}
                  aria-label={translate(
                    'auto.components.sidebar.WorktreeCard.6f09f58541',
                    'Delete workspace'
                  )}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                {translate('auto.components.sidebar.WorktreeCard.6f09f58541', 'Delete workspace')}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}
