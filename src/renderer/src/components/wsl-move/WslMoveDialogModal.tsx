import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
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
import { wslMoveBlockerProjects, wslMoveProjectRows } from './wsl-move-scope-rows'
import type { WslMoveCatalog } from './wsl-move-scope-rows'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { closeWslMoveDialog, reloadAfterWslMove } from './wsl-move-dialog-close'
import { WslMovePreviewBody, wslMoveNotMovingLines } from './WslMovePreviewBody'
import { WslMoveProgressBody } from './WslMoveProgressBody'
import { WslMoveResultBody, wslMoveResultTitle } from './WslMoveResultBody'
import type {
  WslMoveBlocker,
  WslMoveRowRef
} from '../../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveBlockerView } from './WslMoveBlockerList'

function useMoveCatalog(): WslMoveCatalog {
  return useAppStore(
    useShallow((state) => ({
      repos: state.repos,
      folders: selectFolderWorkspaces(state),
      // oxlint-disable-next-line app-store-performance/no-whole-hot-map-selector -- move catalog inspects tabs across all candidate projects while the modal is open
      unifiedTabsByWorktree: state.unifiedTabsByWorktree
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

export function WslMoveDialogModal(): React.JSX.Element | null {
  const t = useTranslate()
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
      title = t('wslMove.title', 'Move projects to the {{distro}} host', { distro })
      body = (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoadingSpinner className="size-4" />
          {t('wslMove.loading', 'Checking the projects in {{distro}}…', { distro })}
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
      title = t('wslMove.title', 'Move projects to the {{distro}} host', { distro })
      body = (
        <WslMovePreviewBody
          distro={distro}
          rows={rows}
          selected={selected}
          counts={
            // Main counts what the move itself would carry; nothing is shown until it answers.
            preview?.outcome === 'ready' && preview.counts
              ? { projects: selected.length, ...preview.counts }
              : null
          }
          preview={preview}
          notMoving={wslMoveNotMovingLines(dialog.distroPreview, nameOf, distro, t)}
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
      title = t('wslMove.runningTitle', 'Moving to the {{distro}} host', { distro })
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
      title = wslMoveResultTitle(result, distro, t)
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
