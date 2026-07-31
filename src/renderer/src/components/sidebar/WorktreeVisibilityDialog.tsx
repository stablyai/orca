import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleHelp, Info } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  effectiveAgentWorktreeVisibility,
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree-ownership'
import { translate } from '@/i18n/i18n'
import NonOrcaWorktreeSection from './NonOrcaWorktreeSection'
import {
  buildAgentWorktreeRows,
  buildOtherWorktreeRows,
  summarizeAgentWorktreeVisibility,
  summarizeOtherWorktreeVisibility,
  type NonOrcaWorktreeRow
} from './non-orca-worktree-visibility-candidates'
import { setNonOrcaWorktreeKindVisibility } from './non-orca-worktree-switch-actions'
import {
  importNewExternalWorktreeInboxPaths,
  undoExternalWorktreeImportPaths,
  type NewExternalWorktreesInboxActionState
} from './new-external-worktrees-inbox-actions'

const EMPTY_KIND_SUMMARY = {
  total: 0,
  shownCount: 0,
  allShown: false,
  hiddenPaths: [],
  shownPaths: []
}

export default function WorktreeVisibilityDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const guideDismissed = useAppStore((s) => s.nonOrcaWorktreeGuideDismissed)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const dismissGuide = useAppStore((s) => s.dismissNonOrcaWorktreeGuide)
  const [actionState, setActionState] = useState<NewExternalWorktreesInboxActionState | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [guideReopened, setGuideReopened] = useState(false)
  const [listState, setListState] = useState<'checking' | 'ready' | 'failed'>('checking')

  const isOpen = activeModal === 'worktree-visibility'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const repo = repos.find((candidate) => candidate.id === repoId) ?? null
  const detected = repoId ? detectedWorktreesByRepo[repoId] : undefined
  const showOther = repo
    ? effectiveExternalWorktreeVisibility(repo, isLegacyRepoForExternalWorktreeVisibility(repo)) ===
      'show'
    : false
  const otherSummary = useMemo(
    () => (repo ? summarizeOtherWorktreeVisibility(detected, repo) : EMPTY_KIND_SUMMARY),
    [detected, repo]
  )
  const hasAuthoritativeList = detected?.authoritative === true
  const agentRows = useMemo(
    () => (repo ? buildAgentWorktreeRows(detected, repo) : []),
    [detected, repo]
  )
  const otherRows = useMemo(
    () => (repo ? buildOtherWorktreeRows(detected, repo) : []),
    [detected, repo]
  )
  const agentSummary = useMemo(
    () => (repo ? summarizeAgentWorktreeVisibility(detected, repo) : EMPTY_KIND_SUMMARY),
    [detected, repo]
  )
  const showAgentScratch = repo ? effectiveAgentWorktreeVisibility(repo) === 'show' : false
  // Why: exceptions can show every row while the setting still says hide, and a bulk
  // button that reads Show all there would leave no way to hide what is on screen.
  const anyAgentShown = showAgentScratch || agentSummary.shownCount > 0
  const anyOtherShown = showOther || otherSummary.shownCount > 0
  const pending = actionState?.pending === true
  // Why: the dismissal flag defaults to false until persisted UI hydrates, so without
  // this the primer flashes back for someone who already dismissed it.
  const showGuide = guideReopened || (persistedUIReady && !guideDismissed)

  // Why: reopening must reflect scratch created since the last look, and a stale
  // fallback snapshot lists nothing, which would read as "nothing hidden".
  useEffect(() => {
    if (!isOpen || !repoId) {
      return
    }
    let cancelled = false
    setListState('checking')
    void fetchWorktrees(repoId, { requireAuthoritative: true }).then((refreshed) => {
      if (cancelled) {
        return
      }
      setListState(refreshed ? 'ready' : 'failed')
    })
    return () => {
      cancelled = true
    }
  }, [fetchWorktrees, isOpen, repoId])

  const handleRetryList = useCallback(async () => {
    if (!repoId) {
      return
    }
    setListState('checking')
    const refreshed = await fetchWorktrees(repoId, { requireAuthoritative: true })
    setListState(refreshed ? 'ready' : 'failed')
  }, [fetchWorktrees, repoId])

  const runPathAction = useCallback(
    async (worktreePaths: readonly string[], intent: 'show' | 'hide') => {
      if (!repo || worktreePaths.length === 0) {
        return
      }
      setBusyPath(worktreePaths.length === 1 ? worktreePaths[0] : null)
      const args = {
        projectId: repo.id,
        repo,
        worktreePaths,
        updateRepo,
        fetchWorktrees,
        setInboxState: (_projectId: string, state: NewExternalWorktreesInboxActionState | null) =>
          setActionState(state)
      }
      await (intent === 'show'
        ? importNewExternalWorktreeInboxPaths(args)
        : undoExternalWorktreeImportPaths(args))
      setBusyPath(null)
    },
    [fetchWorktrees, repo, updateRepo]
  )

  const handleToggleRowVisibility = useCallback(
    (row: NonOrcaWorktreeRow) => {
      void runPathAction([row.path], row.visible ? 'hide' : 'show')
    },
    [runPathAction]
  )

  const handleToggleAgentScratchSetting = useCallback(async () => {
    if (!repo) {
      return
    }
    await setNonOrcaWorktreeKindVisibility({
      repo,
      detected,
      kind: 'agent-scratch',
      next: anyAgentShown ? 'hide' : 'show',
      previous: showAgentScratch ? 'show' : 'hide',
      setSwitchState: setActionState,
      updateRepo,
      fetchWorktrees
    })
  }, [anyAgentShown, detected, fetchWorktrees, repo, showAgentScratch, updateRepo])

  const handleToggleOtherSetting = useCallback(async () => {
    if (!repo) {
      return
    }
    await setNonOrcaWorktreeKindVisibility({
      repo,
      detected,
      kind: 'other',
      next: anyOtherShown ? 'hide' : 'show',
      previous: showOther ? 'show' : 'hide',
      setSwitchState: setActionState,
      updateRepo,
      fetchWorktrees
    })
  }, [anyOtherShown, detected, fetchWorktrees, repo, showOther, updateRepo])

  if (!isOpen || !repo || !isGitRepoKind(repo)) {
    return null
  }

  const checkingLabel = translate(
    'auto.components.sidebar.WorktreeVisibilityDialog.06de1a8f1e',
    'Checking…'
  )
  const noneLabel = translate(
    'auto.components.sidebar.WorktreeVisibilityDialog.f5cd907e0d',
    'None in this repo.'
  )
  const unavailableLabel = translate(
    'auto.components.sidebar.WorktreeVisibilityDialog.0c7f28d914',
    'Not available'
  )
  const shownStateLabel = translate(
    'auto.components.sidebar.WorktreeVisibilityDialog.3e045d4cb8',
    'Shown in sidebar'
  )
  const hiddenStateLabel = translate(
    'auto.components.sidebar.WorktreeVisibilityDialog.5d02a5647f',
    'Hidden from sidebar'
  )
  const showAllLabel = translate(
    'auto.components.sidebar.WorktreeVisibilityDialog.5bc36fd473',
    'Show all'
  )
  const hideAllLabel = translate(
    'auto.components.sidebar.WorktreeVisibilityDialog.4ab25ec362',
    'Hide all'
  )
  const guideLabel = translate(
    'auto.components.sidebar.WorktreeVisibilityDialog.e5b1027c94',
    'What is this?'
  )

  const shownTogetherLabel = (count: number): string =>
    count === 1
      ? translate(
          'auto.components.sidebar.WorktreeVisibilityDialog.1d84f0a29b',
          '1 worktree shown together'
        )
      : translate(
          'auto.components.sidebar.WorktreeVisibilityDialog.2e95a1b30c',
          '{{value0}} worktrees shown together',
          { value0: count }
        )
  const hiddenTogetherLabel = (count: number): string =>
    count === 1
      ? translate(
          'auto.components.sidebar.WorktreeVisibilityDialog.3fa6b2c41d',
          '1 worktree hidden together'
        )
      : translate(
          'auto.components.sidebar.WorktreeVisibilityDialog.40b7c3d52e',
          '{{value0}} worktrees hidden together',
          { value0: count }
        )
  const partlyShownLabel = translate(
    'auto.components.sidebar.WorktreeVisibilityDialog.6bd8f5a02c',
    'Partly shown in sidebar'
  )
  const someOfTotalShownLabel = (shown: number, total: number): string =>
    translate(
      'auto.components.sidebar.WorktreeVisibilityDialog.7ce6903db5',
      '{{value0}} of {{value1}} shown',
      { value0: shown, value1: total }
    )
  const kindCountLabel = (
    summary: { total: number; shownCount: number },
    allShownBySwitch: boolean
  ): string => {
    if (!hasAuthoritativeList) {
      return listState === 'failed' ? unavailableLabel : checkingLabel
    }
    if (summary.total === 0) {
      return noneLabel
    }
    if (allShownBySwitch) {
      return shownTogetherLabel(summary.total)
    }
    if (summary.shownCount > 0) {
      return someOfTotalShownLabel(summary.shownCount, summary.total)
    }
    return hiddenTogetherLabel(summary.total)
  }
  // Why: "Partly" only when something is actually held back; every row shown one by one
  // is still shown, even though the switch keeps later ones hidden.
  const kindStateLabel = (
    summary: { total: number; shownCount: number },
    allShownBySwitch: boolean
  ): string => {
    if (allShownBySwitch || (summary.total > 0 && summary.shownCount === summary.total)) {
      return shownStateLabel
    }
    return summary.shownCount > 0 ? partlyShownLabel : hiddenStateLabel
  }

  const agentStateLabel = kindStateLabel(agentSummary, showAgentScratch)
  const agentCountLabel = kindCountLabel(agentSummary, showAgentScratch)
  const otherStateLabel = kindStateLabel(otherSummary, showOther)
  const otherCountLabel = kindCountLabel(otherSummary, showOther)
  const bulkActionsDisabled = listState !== 'ready' || !hasAuthoritativeList

  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="grid min-w-0 gap-2 pr-6">
            <div className="flex min-w-0 items-baseline gap-2">
              <DialogTitle>
                {translate(
                  'auto.components.sidebar.WorktreeVisibilityDialog.83a5ba8dd1',
                  'Non-Orca worktrees'
                )}
              </DialogTitle>
              {showGuide ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-auto shrink-0 gap-1 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setGuideReopened(true)}
                >
                  <CircleHelp className="size-3" />
                  {guideLabel}
                </Button>
              )}
            </div>
            <DialogDescription>{repo.displayName}</DialogDescription>
          </div>
        </DialogHeader>

        {showGuide ? (
          <div className="orca-contextual-tour-panel min-w-0 rounded-lg border border-border p-4 text-popover-foreground">
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              {translate(
                'auto.components.sidebar.WorktreeVisibilityDialog.f6c2138da5',
                'Two kinds of non-Orca worktrees'
              )}
            </h3>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              {translate(
                'auto.components.sidebar.WorktreeVisibilityDialog.1af4360b27',
                'Anything created through Orca always shows in the sidebar, whether you or an agent asked for it. This screen is about worktrees created outside Orca: the ones agents make directly in the repo, like .claude/worktrees, and the ones made by hand with git. Each kind has its own switch below.'
              )}
            </p>
            <div className="mt-3.5 flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setGuideReopened(false)
                  dismissGuide()
                }}
              >
                {translate('auto.components.sidebar.WorktreeVisibilityDialog.d3ab7e5c8b', 'Got it')}
              </Button>
            </div>
          </div>
        ) : null}

        <NonOrcaWorktreeSection
          title={translate(
            'auto.components.sidebar.WorktreeVisibilityDialog.3c17e40b95',
            'Agent scratch worktrees'
          )}
          description={translate(
            'auto.components.sidebar.WorktreeVisibilityDialog.2b05471c38',
            'Created by agents directly in the repo, outside Orca.'
          )}
          anyShown={anyAgentShown}
          stateLabel={agentStateLabel}
          countLabel={agentCountLabel}
          bulkActionLabel={anyAgentShown ? hideAllLabel : showAllLabel}
          onBulkAction={handleToggleAgentScratchSetting}
          bulkActionDisabled={bulkActionsDisabled}
          rows={agentRows}
          busyPath={busyPath}
          pending={pending}
          onToggleVisibility={handleToggleRowVisibility}
        />

        <NonOrcaWorktreeSection
          title={translate(
            'auto.components.sidebar.WorktreeVisibilityDialog.4d9e6a3c2a',
            'Other worktrees'
          )}
          description={translate(
            'auto.components.sidebar.WorktreeVisibilityDialog.29f5d4a1b8',
            'Created by hand or by another tool.'
          )}
          anyShown={anyOtherShown}
          stateLabel={otherStateLabel}
          countLabel={otherCountLabel}
          bulkActionLabel={anyOtherShown ? hideAllLabel : showAllLabel}
          onBulkAction={handleToggleOtherSetting}
          bulkActionDisabled={bulkActionsDisabled}
          rows={otherRows}
          busyPath={busyPath}
          pending={pending}
          onToggleVisibility={handleToggleRowVisibility}
        />

        <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 leading-5">
              {translate(
                'auto.components.sidebar.WorktreeVisibilityDialog.18e435afc7',
                'Both switches also cover worktrees created later. Hiding a kind clears the worktrees you had shown individually.'
              )}
            </p>
          </div>
        </div>

        {listState === 'failed' ? (
          <div className="flex min-w-0 items-center gap-3" role="alert">
            <p className="min-w-0 flex-1 text-xs text-destructive">
              {translate(
                'auto.components.sidebar.WorktreeVisibilityDialog.51c8d4e63f',
                "Could not list this repo's worktrees."
              )}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={handleRetryList}>
              {translate(
                'auto.components.sidebar.WorktreeVisibilityDialog.9ad3e71b06',
                'Try again'
              )}
            </Button>
          </div>
        ) : null}

        {actionState?.error ? (
          <p className="text-xs text-destructive" role="alert">
            {actionState.error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
