import {
  selectCrossStoreFolderChildrenById,
  selectSidebarLineageParentIdentities
} from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import {
  getAttachedWorktreesForFolderWorkspace,
  attachedWorktreeOwnerKey
} from './folder-workspace-attached-worktrees'
import { resolveReviewRepository } from '@/lib/source-control/review/review-owner'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { OverlayActivityOwner } from '@/components/ui/use-overlay-focus-scope'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getWorktreeGitIdentityDisplay } from '../../../../../shared/worktree/row-display/git-identity-display'
import { isFolderRepo } from '../../../../../shared/repo-kind'
import { SourceControlPanel } from '../source-control/panel/panel'
import {
  SourceControlScopeProvider,
  type SourceControlScope
} from '../source-control/panel/worktree-scope'
import { SourceControlHeaderOverflowMenu } from '../source-control/panel/header-overflow-menu'
import { SourceControlHeaderActionsSlot } from '../source-control/panel/header-actions-slot'
import { useWorktreeGitStatusObservation } from '../source-control/sync/use-worktree-git-status-observation'
import { useSourceControlWatchConsumer } from '@/hooks/source-control-watch-consumers'
import { useSectionOnScreen } from '../source-control/panel/section-viewport-presence'
import { sourceControlFileWatchRuntimeEnvironmentId } from '../source-control/sync/worktree-git-owner-target'
import { FolderWorkspaceEmptyState } from './folder-workspace-empty-state'
import {
  FOLDER_WORKTREE_CARD_CLASS,
  FolderWorktreeSectionHeader
} from './folder-worktree-section-header'
const EMPTY_ENTRIES: readonly unknown[] = []

type SectionProps = {
  owner: SourceControlScope
  scrollRoot: Element | null
  refreshers: Set<() => void>
}

const WorktreeSection = memo(
  function WorktreeSection({ owner, scrollRoot, refreshers }: SectionProps) {
    const t = useTranslate()
    useUiLanguageRevision()
    const id = owner.worktreeId
    const entries = useAppStore((state) => state.gitStatusByWorktree[id] ?? EMPTY_ENTRIES)
    const statusKnown = useAppStore((state) => Object.hasOwn(state.gitStatusByWorktree, id))
    const remote = useAppStore((state) => state.remoteStatusesByWorktree[id])
    const error = useAppStore((state) => state.gitStatusReadErrorByWorktree[id])
    const huge = useAppStore((state) => state.gitStatusHugeByWorktree[id])
    const connected = useAppStore(
      (state) =>
        !owner.repo.connectionId ||
        state.sshConnectionStates.get(owner.repo.connectionId)?.status === 'connected'
    )
    const [expanded, setExpanded] = useState<boolean | undefined>()
    const isExpanded = expanded ?? (statusKnown ? entries.length > 0 : true)
    // Decide once at the first result; later agent edits update badges without undoing a user's collapse.
    if (expanded === undefined && statusKnown) {
      setExpanded(entries.length > 0)
    }
    const refreshNow = useWorktreeGitStatusObservation(owner, { enabled: true })
    useEffect(() => {
      refreshers.add(refreshNow)
      return () => {
        refreshers.delete(refreshNow)
      }
    }, [refreshNow, refreshers])
    const [sectionRef, onScreen] = useSectionOnScreen(scrollRoot)
    const bodyShown =
      isExpanded && connected && (statusKnown || error !== undefined || isFolderRepo(owner.repo))
    // Open overlays keep their section live until they close, including while off screen.
    const [openOverlays, setOpenOverlays] = useState(() => new Set<HTMLElement>())
    const onOverlayActivity = useCallback((overlay: HTMLElement, open: boolean) => {
      setOpenOverlays((current) => {
        if (current.has(overlay) === open) {
          return current
        }
        const next = new Set(current)
        if (open) {
          next.add(overlay)
        } else {
          next.delete(overlay)
        }
        return next
      })
    }, [])
    const bodyActive = (bodyShown && onScreen) || openOverlays.size > 0
    // Mount on first sight, then keep the body so selection, history view and focus survive scrolling and collapse.
    const [bodyMounted, setBodyMounted] = useState(false)
    if (bodyActive && !bodyMounted) {
      setBodyMounted(true)
    }
    const watchRuntimeEnvironmentId = useAppStore((state) =>
      sourceControlFileWatchRuntimeEnvironmentId(state, owner)
    )
    // Only local or served-runtime roots have the existing watch transport; huge repos keep their pause.
    useSourceControlWatchConsumer(
      attachedWorktreeOwnerKey(owner),
      connected && !huge && !isFolderRepo(owner.repo) && watchRuntimeEnvironmentId !== undefined
        ? {
            worktreeId: id,
            worktreePath: owner.worktree.path,
            connectionId: owner.repo.connectionId ?? undefined,
            runtimeEnvironmentId: watchRuntimeEnvironmentId
          }
        : null
    )
    const panel = useMemo(() => <SourceControlPanel />, [])
    const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null)
    const identity = getWorktreeGitIdentityDisplay(owner.worktree)
    return (
      <section
        ref={sectionRef}
        className={FOLDER_WORKTREE_CARD_CLASS}
        data-source-control-worktree={id}
      >
        <FolderWorktreeSectionHeader
          repoName={owner.repo.displayName}
          worktreeName={owner.worktree.displayName}
          branch={
            identity?.kind === 'detached'
              ? identity.sourceControlLabel
              : (identity?.branchName ?? owner.worktree.branch)
          }
          ahead={remote?.ahead}
          behind={remote?.behind}
          changeCount={entries.length}
          expanded={isExpanded}
          showBranchInHeader={!bodyShown || !bodyMounted || isFolderRepo(owner.repo)}
          actions={
            isExpanded && (!bodyShown || !bodyMounted || isFolderRepo(owner.repo)) ? (
              <SourceControlHeaderOverflowMenu worktree={owner.worktree} />
            ) : null
          }
          onToggle={() => setExpanded(!isExpanded)}
          onOpen={() => {
            activateAndRevealWorktree(id, {
              navigationIntent: 'user-open',
              executionHostId: owner.executionHostId,
              clearSidebarFilters: false
            })
          }}
          actionsSlotRef={setActionsSlot}
        />
        {isExpanded &&
          (!connected ? (
            <div className="px-4 pb-2 text-xs text-muted-foreground">
              {t(
                'auto.components.rightSidebar.FolderWorkspaceSourceControl.reconnect',
                'Reconnect to see this worktree’s changes.'
              )}
            </div>
          ) : !bodyShown ? (
            <div className="h-24 space-y-2 p-3" aria-busy="true">
              <div className="h-2 w-3/4 rounded bg-muted" />
              <div className="h-2 w-1/2 rounded bg-muted" />
            </div>
          ) : (
            !bodyMounted && <div className="h-24" aria-hidden="true" />
          ))}
        {bodyMounted && (
          // A read error renders the body's existing failure banner with Retry.
          <div hidden={!bodyShown}>
            <OverlayActivityOwner.Provider value={onOverlayActivity}>
              <SourceControlHeaderActionsSlot.Provider value={bodyShown ? actionsSlot : null}>
                <SourceControlScopeProvider owner={owner} active={bodyActive}>
                  {panel}
                </SourceControlScopeProvider>
              </SourceControlHeaderActionsSlot.Provider>
            </OverlayActivityOwner.Provider>
          </div>
        )}
      </section>
    )
  },
  (left, right) =>
    left.scrollRoot === right.scrollRoot &&
    left.refreshers === right.refreshers &&
    left.owner.worktree === right.owner.worktree &&
    left.owner.repo === right.owner.repo &&
    left.owner.placementWorkspaceId === right.owner.placementWorkspaceId
)

export default function FolderWorkspaceSourceControlPanel() {
  const t = useTranslate()
  const activeWorkspaceKey = useAppStore((state) => state.activeWorkspaceKey)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const executionHostId = useAppStore((state) => state.activeWorkspaceExecutionHostId)
  const folderWorkspaces = useAppStore(selectFolderWorkspaces)
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  const workspaceLineageByChildKey = useAppStore((state) => state.workspaceLineageByChildKey)
  const worktreeLineageById = useAppStore((state) => state.worktreeLineageById)
  const lineageParentIdentities = useAppStore(selectSidebarLineageParentIdentities)
  const crossStoreChildrenByFolderId = useAppStore(selectCrossStoreFolderChildrenById)
  const repos = useAppStore((state) => state.repos)
  const resolution = useMemo(
    () =>
      getAttachedWorktreesForFolderWorkspace({
        activeWorkspaceKey,
        activeWorktreeId,
        executionHostId,
        folderWorkspaces,
        worktreesByRepo,
        workspaceLineageByChildKey,
        worktreeLineageById,
        lineageParentIdentities,
        crossStoreChildrenByFolderId
      }),
    [
      activeWorkspaceKey,
      activeWorktreeId,
      executionHostId,
      folderWorkspaces,
      worktreesByRepo,
      workspaceLineageByChildKey,
      worktreeLineageById,
      lineageParentIdentities,
      crossStoreChildrenByFolderId
    ]
  )
  const owners = useMemo(
    () =>
      resolution.owners.flatMap((owner) => {
        const repo = resolveReviewRepository(repos, owner.worktree)
        return repo && resolution.folderWorkspace
          ? [{ ...owner, repo, placementWorkspaceId: `folder:${resolution.folderWorkspace.id}` }]
          : []
      }),
    [resolution, repos]
  )
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [refreshers] = useState(() => new Set<() => void>())
  // Each section's scheduler applies the status tier, coalescing, abort and stale-result guards.
  const refresh = () => {
    for (const refreshNow of refreshers) {
      refreshNow()
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{resolution.folderWorkspace?.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {t(
              'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.attachedCount',
              '{{count}} attached worktrees',
              { count: owners.length, defaultValue_one: '{{count}} attached worktree' }
            )}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              onClick={refresh}
              aria-label={t(
                'auto.components.right.sidebar.SourceControl.refreshAll',
                'Refresh all'
              )}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t('auto.components.right.sidebar.SourceControl.refreshAll', 'Refresh all')}
          </TooltipContent>
        </Tooltip>
      </div>
      {owners.length === 0 ? (
        <FolderWorkspaceEmptyState
          folderWorkspace={resolution.folderWorkspace ?? null}
          showRepoActions={resolution.owners.length === 0}
          title={t(
            'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.emptyTitle',
            'No attached worktrees yet'
          )}
          copy={t(
            'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.emptyCopy',
            'Worktrees created from this workspace will show up here.'
          )}
        />
      ) : (
        <div
          ref={setScrollRoot}
          className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2"
        >
          {owners.map((owner) => (
            <WorktreeSection
              key={attachedWorktreeOwnerKey(owner)}
              owner={owner}
              scrollRoot={scrollRoot}
              refreshers={refreshers}
            />
          ))}
        </div>
      )}
    </div>
  )
}
