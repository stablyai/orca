import React, { useCallback, useMemo, useState } from 'react'
import { ChevronDown, FolderGit2, Plus, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { cn } from '@/lib/utils'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import {
  bulkDiscardRuntimeGitPaths,
  bulkStageRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths
} from '@/runtime/runtime-git-working-tree-client'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { ActionButton } from '../listing/action-button'
import { UncommittedEntryRow } from '../listing/uncommitted-entry-row'
import { LinkedRepoCommitBox } from './linked-repo-commit-box'
import { findGroupLinkedWorktreeIds } from './linked-worktree-groups'
import { linkWorktree, unlinkWorktree, useLinkedWorktreeIds } from './linked-worktree-store'
import { useLinkedWorktreeStatus, type LinkedWorktreeView } from './use-linked-worktree-status'

const AREA_ORDER: Record<GitStatusEntry['area'], number> = { staged: 0, unstaged: 1, untracked: 2 }

function shortBranch(branch: string | null): string | null {
  return branch ? branch.replace(/^refs\/heads\//, '') : null
}

function sortEntries(entries: readonly GitStatusEntry[]): GitStatusEntry[] {
  return [...entries].sort(
    (a, b) => AREA_ORDER[a.area] - AREA_ORDER[b.area] || a.path.localeCompare(b.path)
  )
}

type Props = {
  activeWorktreeId: string
  activeRepoId: string | null
  isVisible: boolean
  revealInExplorer: (worktreeId: string, absolutePath: string) => void
}

/** Other projects shown with this workspace: same project group, or linked by hand with +. */
export function SourceControlLinkedRepoSections({
  activeWorktreeId,
  activeRepoId,
  isVisible,
  revealInExplorer
}: Props): React.JSX.Element | null {
  useUiLanguageRevision()
  const manualIds = useLinkedWorktreeIds(activeWorktreeId)
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const groupIds = useMemo(
    () =>
      findGroupLinkedWorktreeIds(
        repos,
        getAllWorktreesFromState({ worktreesByRepo }),
        activeWorktreeId
      ),
    [activeWorktreeId, repos, worktreesByRepo]
  )
  const groupIdsKey = groupIds.join('\n')
  // Key on the ids so catalog refreshes that keep the same group do not rebuild the list.
  const linkedIds = useMemo(
    () => [...new Set([...groupIdsKey.split('\n').filter(Boolean), ...manualIds])],
    [groupIdsKey, manualIds]
  )
  const groupIdSet = useMemo(() => new Set(groupIdsKey.split('\n')), [groupIdsKey])
  const enabled = useAppStore((s) => s.settings?.linkedRepositoriesEnabled !== false)
  const { views, refreshOne } = useLinkedWorktreeStatus(linkedIds, isVisible && enabled)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  if (!enabled) {
    return null
  }

  return (
    <div data-testid="source-control-linked-repos" className="border-t border-border/60 mt-2">
      <div className="flex items-center gap-1 pl-3 pr-3 pt-3 pb-1">
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-foreground/70">
          {translate(
            'auto.components.right.sidebar.SourceControl.linkedReposTitle',
            'Linked repositories'
          )}
        </span>
        <AddLinkedRepoMenu
          activeWorktreeId={activeWorktreeId}
          activeRepoId={activeRepoId}
          linkedIds={linkedIds}
        />
      </div>
      {views.length === 0 ? (
        <div className="px-3 pb-2 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.SourceControl.linkedReposEmpty',
            'Link a project with +, or put projects in the same group to show them here.'
          )}
        </div>
      ) : (
        views.map((view) => (
          <LinkedRepoSection
            key={view.worktree.id}
            view={view}
            activeWorktreeId={activeWorktreeId}
            isFromGroup={groupIdSet.has(view.worktree.id)}
            isCollapsed={collapsed.has(view.worktree.id)}
            onToggle={() => toggle(view.worktree.id)}
            onRefresh={() => void refreshOne(view.context)}
            revealInExplorer={revealInExplorer}
          />
        ))
      )}
    </div>
  )
}

function LinkedRepoSection({
  view,
  activeWorktreeId,
  isFromGroup,
  isCollapsed,
  onToggle,
  onRefresh,
  revealInExplorer
}: {
  view: LinkedWorktreeView
  activeWorktreeId: string
  /** Group members leave by changing the project's group, so they get no unlink button. */
  isFromGroup: boolean
  isCollapsed: boolean
  onToggle: () => void
  onRefresh: () => void
  revealInExplorer: (worktreeId: string, absolutePath: string) => void
}): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const { worktree, repo, context } = view
  const entries = useMemo(() => sortEntries(view.entries), [view.entries])
  const branch = shortBranch(view.branch)
  const stagedCount = useMemo(
    () => entries.filter((entry) => entry.area === 'staged').length,
    [entries]
  )
  const hasUnresolvedConflicts = useMemo(
    () => entries.some((entry) => entry.conflictStatus === 'unresolved'),
    [entries]
  )

  const runThenRefresh = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action()
      } catch (error) {
        toast.error(
          translate(
            'auto.components.right.sidebar.SourceControl.linkedReposActionFailed',
            'Git action failed in {{repo}}',
            { repo: repo.displayName }
          ),
          { description: error instanceof Error ? error.message : String(error) }
        )
      } finally {
        onRefresh()
      }
    },
    [onRefresh, repo.displayName]
  )

  const openEntry = useCallback(
    (entry: GitStatusEntry) => {
      const state = useAppStore.getState()
      // The tab stays in this workspace; Git for the diff comes from the linked one.
      state.openDiff(
        activeWorktreeId,
        joinPath(worktree.path, entry.path),
        entry.path,
        detectLanguage(entry.path),
        entry.area === 'staged',
        {
          gitWorktreeId: worktree.id,
          ...(entry.area === 'staged' && entry.status === 'renamed'
            ? { oldPath: entry.oldPath }
            : {})
        }
      )
    },
    [activeWorktreeId, worktree.id, worktree.path]
  )

  const discardEntry = useCallback(
    async (entry: GitStatusEntry) => {
      const accepted = await confirm({
        title: translate(
          'auto.components.right.sidebar.SourceControl.linkedReposDiscardTitle',
          'Discard changes in {{repo}}?',
          { repo: repo.displayName }
        ),
        description: entry.path,
        confirmLabel: translate(
          'auto.components.right.sidebar.SourceControl.d54dd48b0b',
          'Discard changes'
        ),
        confirmVariant: 'destructive'
      })
      if (accepted) {
        await runThenRefresh(() => bulkDiscardRuntimeGitPaths(context, [entry.path]))
      }
    },
    [confirm, context, repo.displayName, runThenRefresh]
  )

  return (
    <div data-testid="source-control-linked-repo" data-worktree-id={worktree.id}>
      <div className="pl-1 pr-3 pt-2 pb-1">
        <div className="group/section flex items-center gap-x-1 rounded-md pr-1 hover:bg-accent hover:text-accent-foreground">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-auto min-h-6 min-w-0 flex-1 justify-start text-left"
            onClick={onToggle}
            aria-expanded={!isCollapsed}
          >
            {/* Spacing and color live on this span; <Button> only takes layout classes. */}
            <span className="flex min-w-0 flex-1 items-center gap-x-1.5 py-0.5 text-foreground/80 group-hover/section:text-accent-foreground">
              <ChevronDown
                className={cn(
                  'size-3.5 shrink-0 transition-transform',
                  isCollapsed && '-rotate-90'
                )}
              />
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: repo.badgeColor }}
                aria-hidden
              />
              <span className="min-w-0 truncate font-semibold" title={worktree.path}>
                {repo.displayName}
              </span>
              {branch && (
                <span className="min-w-0 truncate text-[11px] font-normal text-muted-foreground">
                  {branch}
                </span>
              )}
              <span className="ml-auto shrink-0 text-[11px] font-medium tabular-nums">
                {entries.length}
              </span>
            </span>
          </Button>
          <div className="flex shrink-0 items-center">
            <ActionButton
              icon={RefreshCw}
              title={translate(
                'auto.components.right.sidebar.SourceControl.linkedReposRefresh',
                'Refresh'
              )}
              onClick={onRefresh}
            />
            {!isFromGroup && (
              <ActionButton
                icon={X}
                title={translate(
                  'auto.components.right.sidebar.SourceControl.linkedReposUnlink',
                  'Remove from this workspace'
                )}
                onClick={() => unlinkWorktree(activeWorktreeId, worktree.id)}
              />
            )}
          </div>
        </div>
      </div>
      {!isCollapsed && (
        <>
          {view.error && (
            <div className="px-4 pb-1 text-[11px] text-destructive/80">{view.error}</div>
          )}
          {view.loaded && !view.error && entries.length === 0 && (
            <div className="px-4 pb-1 text-[11px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.SourceControl.linkedReposClean',
                'No changes'
              )}
            </div>
          )}
          {entries.length > 0 && (
            <LinkedRepoCommitBox
              context={context}
              repoName={repo.displayName}
              stagedCount={stagedCount}
              hasUnresolvedConflicts={hasUnresolvedConflicts}
              onCommitted={onRefresh}
            />
          )}
          {entries.map((entry) => (
            <UncommittedEntryRow
              key={`${entry.area}:${entry.path}`}
              entryKey={`linked:${worktree.id}:${entry.area}:${entry.path}`}
              entry={entry}
              currentWorktreeId={activeWorktreeId}
              worktreePath={worktree.path}
              depth={1}
              onRevealInExplorer={revealInExplorer}
              connectionId={context.connectionId ?? null}
              onOpen={openEntry}
              onStage={(filePath) =>
                runThenRefresh(() => bulkStageRuntimeGitPaths(context, [filePath]))
              }
              onUnstage={(filePath) =>
                runThenRefresh(() => bulkUnstageRuntimeGitPaths(context, [filePath]))
              }
              onResolveConflict={async () => openEntry(entry)}
              onDiscard={(target) => void discardEntry(target)}
              commentCount={0}
            />
          ))}
        </>
      )}
    </div>
  )
}

function AddLinkedRepoMenu({
  activeWorktreeId,
  activeRepoId,
  linkedIds
}: {
  activeWorktreeId: string
  activeRepoId: string | null
  linkedIds: readonly string[]
}): React.JSX.Element {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const options = useMemo(() => {
    const repoMap = getRepoMapFromState({ repos })
    const activeRepo = activeRepoId ? repoMap.get(activeRepoId) : undefined
    const hostId = activeRepo ? getRepoExecutionHostId(activeRepo) : null
    const linked = new Set(linkedIds)
    return getAllWorktreesFromState({ worktreesByRepo }).flatMap((worktree) => {
      const repo = repoMap.get(worktree.repoId)
      if (
        !repo ||
        isFolderRepo(repo) ||
        worktree.isArchived ||
        worktree.id === activeWorktreeId ||
        linked.has(worktree.id) ||
        getRepoExecutionHostId(repo) !== hostId
      ) {
        return []
      }
      return [{ worktree, repo }]
    })
  }, [activeRepoId, activeWorktreeId, linkedIds, repos, worktreesByRepo])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
            'auto.components.right.sidebar.SourceControl.linkedReposAdd',
            'Link a repository'
          )}
          disabled={options.length === 0}
        >
          <Plus className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          {translate(
            'auto.components.right.sidebar.SourceControl.linkedReposAdd',
            'Link a repository'
          )}
        </DropdownMenuLabel>
        {options.map(({ worktree, repo }) => (
          <DropdownMenuItem
            key={worktree.id}
            onSelect={() => linkWorktree(activeWorktreeId, worktree.id)}
          >
            <FolderGit2 className="size-3.5" style={{ color: repo.badgeColor }} />
            <span className="min-w-0 truncate">{repo.displayName}</span>
            <span className="ml-auto min-w-0 truncate pl-2 text-[11px] text-muted-foreground">
              {shortBranch(worktree.branch) ?? worktree.displayName}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
