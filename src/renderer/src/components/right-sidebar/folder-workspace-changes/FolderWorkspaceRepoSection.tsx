import React from 'react'
import { ChevronDown, FolderGit2, Undo2 } from 'lucide-react'
import { branchName } from '@/lib/git-utils'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { GitStatusEntry } from '../../../../../shared/git-status-types'
import { ActionButton } from '../source-control/listing/action-button'
import { UncommittedEntryRow } from '../source-control/listing/uncommitted-entry-row'
import type { SourceControlRowOpenEvent } from '../source-control/listing/split-open'
import {
  buildRepoEntryKey,
  isRepoDiscardBlocked,
  type FolderWorkspaceChangedRepo
} from './changed-repo-model'

export function FolderWorkspaceRepoSection({
  repo,
  worktreeId,
  connectionId,
  isCollapsed,
  isExecutingDiscard,
  onToggle,
  onOpenEntry,
  onStage,
  onUnstage,
  onDiscardEntry,
  onDiscardRepo,
  onRevealInExplorer
}: {
  repo: FolderWorkspaceChangedRepo
  worktreeId: string
  connectionId: string | null
  isCollapsed: boolean
  isExecutingDiscard: boolean
  onToggle: () => void
  onOpenEntry: (entry: GitStatusEntry, event?: SourceControlRowOpenEvent) => void
  onStage: (filePath: string) => Promise<void>
  onUnstage: (filePath: string) => Promise<void>
  onDiscardEntry: (entry: GitStatusEntry) => void
  onDiscardRepo: () => void
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
}): React.JSX.Element {
  // Why: a capped status keeps the button clickable so the click explains why the discard is refused.
  const discardAllLabel = isRepoDiscardBlocked(repo)
    ? translate(
        'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardAllInRepoBlocked',
        'Too many changes in {{value0}} to discard all at once',
        { value0: repo.name }
      )
    : translate(
        'auto.components.rightSidebar.FolderWorkspaceChangesPanel.discardAllInRepo',
        'Discard all changes in {{value0}}',
        { value0: repo.name }
      )

  return (
    <div data-testid="folder-workspace-changes-repo" data-repo-path={repo.path}>
      <div className="pl-1 pr-3 pt-2 pb-0.5">
        <div className="group/repo flex items-center gap-x-1 rounded-md pr-1 hover:bg-accent hover:text-accent-foreground">
          <button
            type="button"
            className="flex min-h-6 min-w-0 flex-1 items-center gap-x-1.5 rounded-md px-1 py-0.5 text-left text-xs font-medium text-foreground/80 group-hover/repo:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onToggle}
            aria-expanded={!isCollapsed}
            title={repo.path}
          >
            <ChevronDown
              className={cn('size-3.5 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
            />
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="min-w-0 truncate">{repo.name}</span>
              {repo.branch ? (
                <span className="min-w-0 truncate text-[11px] font-normal text-muted-foreground">
                  {branchName(repo.branch)}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
              {repo.entries.length}
            </span>
          </button>
          <div className="ml-auto flex shrink-0 items-center justify-end">
            <ActionButton
              icon={Undo2}
              title={discardAllLabel}
              onClick={onDiscardRepo}
              disabled={isExecutingDiscard}
            />
          </div>
        </div>
      </div>
      {!isCollapsed && (
        <div>
          {repo.entries.map((entry) => (
            <UncommittedEntryRow
              key={buildRepoEntryKey(repo.path, entry)}
              entryKey={buildRepoEntryKey(repo.path, entry)}
              entry={entry}
              currentWorktreeId={worktreeId}
              worktreePath={repo.path}
              depth={1}
              connectionId={connectionId}
              onOpen={onOpenEntry}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscardEntry}
              onRevealInExplorer={onRevealInExplorer}
              commentCount={0}
            />
          ))}
        </div>
      )}
    </div>
  )
}
