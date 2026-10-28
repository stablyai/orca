import React, { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import type {
  WslMoveBlocker,
  WslMoveRowRef
} from '../../../../shared/wsl-move/wsl-move-driver-types'
import {
  cancelWslMove,
  wslMoveDialogLocked,
  recheckWslMove,
  reviewWslMoveAgain,
  setWslMoveSelection,
  skipWslMoveProjects,
  startWslMove,
  useWslMoveDialogStore
} from './wsl-move-dialog-store'
import { collectWslMoveSleptPaneBindings } from './wsl-move-slept-pane-bindings'
import { findWorktreeById } from '@/store/github/worktree-refresh'
import { getWslDistroFromPath } from '@/lib/local-preflight-context'
import {
  wslMoveBlockerProjects,
  wslMoveCounts,
  wslMoveProjectRows,
  type WslMoveCatalog
} from './wsl-move-scope-rows'
import type { WslMoveBlockerView } from './WslMoveBlockerList'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { adoptWslMoveProgress } from './wsl-move-run-adoption'
import { closeWslMoveDialog, reloadAfterWslMove } from './wsl-move-dialog-close'
import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import { useWslHostsEnabled } from '../sidebar/use-wsl-hosts-enabled'
import { WslMovePreviewBody, wslMoveNotMovingLines } from './WslMovePreviewBody'
import { WslMoveProgressBody } from './WslMoveProgressBody'
import { WslMoveResultBody, wslMoveResultTitle } from './WslMoveResultBody'

function useMoveCatalog(): WslMoveCatalog {
  return useAppStore(
    useShallow((state) => ({
      repos: state.repos,
      folders: selectFolderWorkspaces(state),
      repoWorktrees: selectWorktreesByRepo(state),
      unifiedTabsByWorktree: state.unifiedTabsByWorktree,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId
    }))
  )
}

function blockerViews(
  catalog: WslMoveCatalog,
  blockers: readonly WslMoveBlocker[],
  selected: readonly WslMoveRowRef[]
): WslMoveBlockerView[] {
  return blockers.map((blocker) => {
    const refs = wslMoveBlockerProjects(catalog, blocker, selected)
    return {
      blocker,
      projects: wslMoveProjectRows(
        catalog,
        refs.filter((ref) => ref.kind === 'repo').map((ref) => ref.id),
        refs.filter((ref) => ref.kind === 'folder').map((ref) => ref.id)
      )
    }
  })
}

/** Root-hosted: entry points in Settings, the sidebar and project settings all open it. */
export function WslMoveDialogHost(): React.JSX.Element | null {
  const enabled = useWslHostsEnabled()
  const open = useWslMoveDialogStore(
    (s) => s.dialog.stage !== 'closed' && !('hidden' in s.dialog && s.dialog.hidden)
  )
  // A run this window did not start (it reloaded mid-move) still gets its progress and reload.
  useEffect(
    () => (enabled ? window.api.wslMove.onProgress(adoptWslMoveProgress) : undefined),
    [enabled]
  )
  // Opening a bridge project is the trigger bridge users give; main checks it runs.
  // Gated so flag-off windows skip the per-update worktree lookup.
  const activeWslDistro = useAppStore((s) => {
    const worktree = enabled && s.activeWorktreeId ? findWorktreeById(s, s.activeWorktreeId) : null
    return worktree ? getWslDistroFromPath(worktree.path) : null
  })
  useEffect(() => {
    if (enabled && activeWslDistro) {
      void window.api.wslMove.orchestratorProjectOpened(activeWslDistro)
    }
  }, [enabled, activeWslDistro])
  // An automatic move (D3a) needs this window's slept-pane bindings, as the dialog's start does.
  useEffect(
    () =>
      enabled
        ? window.api.wslMove.onOrchestratorSleptPanesRequest((requestId) => {
            void window.api.wslMove.answerOrchestratorSleptPanes(
              requestId,
              collectWslMoveSleptPaneBindings(useAppStore.getState())
            )
          })
        : undefined,
    [enabled]
  )
  return open ? (
    <RecoverableRenderErrorBoundary boundaryId="modal.wsl-move" surface="modal" compact>
      <WslMoveDialog />
    </RecoverableRenderErrorBoundary>
  ) : null
}

function WslMoveDialog(): React.JSX.Element | null {
  const dialog = useWslMoveDialogStore((s) => s.dialog)
  const catalog = useMoveCatalog()
  if (dialog.stage === 'closed') {
    return null
  }
  const { distro } = dialog
  // Locked until the moved window tries its reload; a running move only hides on close.
  const locked = wslMoveDialogLocked(dialog)
  const running = dialog.stage === 'running'
  let title: string
  let body: React.JSX.Element
  switch (dialog.stage) {
    case 'loading':
      title = translate('wslMove.title', 'Move projects to the {{distro}} host', { distro })
      body = (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoadingSpinner className="size-4" />
          {translate('wslMove.loading', 'Checking the projects in {{distro}}…', { distro })}
        </div>
      )
      break
    case 'preview': {
      const { candidates, selected, preview } = dialog
      const rows = wslMoveProjectRows(catalog, candidates.repoIds, candidates.folderWorkspaceIds)
      const nameOf = (ref: WslMoveRowRef): string =>
        wslMoveProjectRows(
          catalog,
          ref.kind === 'repo' ? [ref.id] : [],
          ref.kind === 'folder' ? [ref.id] : []
        )[0].name
      title = translate('wslMove.title', 'Move projects to the {{distro}} host', { distro })
      body = (
        <WslMovePreviewBody
          distro={distro}
          rows={rows}
          selected={selected}
          counts={wslMoveCounts(catalog, selected)}
          preview={preview}
          notMoving={wslMoveNotMovingLines(dialog.distroPreview, nameOf, distro)}
          blockers={
            preview?.outcome === 'ready' ? blockerViews(catalog, preview.blockers, selected) : []
          }
          onToggle={(ref, checked) =>
            setWslMoveSelection(
              checked
                ? [...selected, ref]
                : selected.filter((s) => s.kind !== ref.kind || s.id !== ref.id)
            )
          }
          onSkip={skipWslMoveProjects}
          onRecheck={() => void recheckWslMove()}
          onStart={() => void startWslMove()}
          onClose={closeWslMoveDialog}
        />
      )
      break
    }
    case 'running':
      title = translate('wslMove.runningTitle', 'Moving to the {{distro}} host', { distro })
      body = (
        <WslMoveProgressBody
          progress={dialog.progress}
          cancel={dialog.cancel}
          onCancel={() => void cancelWslMove()}
        />
      )
      break
    case 'result': {
      const { result } = dialog
      title = wslMoveResultTitle(result, distro)
      body = (
        <WslMoveResultBody
          distro={distro}
          result={result}
          blockers={
            result.outcome === 'refused' && result.blockers
              ? blockerViews(catalog, result.blockers, dialog.selected)
              : []
          }
          reload={dialog.reload}
          onReload={() => void reloadAfterWslMove()}
          onReview={() => void reviewWslMoveAgain()}
          onClose={closeWslMoveDialog}
        />
      )
      break
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          closeWslMoveDialog()
        }
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={!locked}
        data-testid="wsl-move-dialog"
        // A stray click must not hide a running move, nor Esc skip a pending reload.
        onEscapeKeyDown={(event) => locked && event.preventDefault()}
        onInteractOutside={(event) => (locked || running) && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{title}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  )
}
