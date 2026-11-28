import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { useAppStore } from '@/store/index'
import type { FileContent } from '../../loading/editor-panel-content-types'
import { reloadEditorFileFromDisk } from './editor-reload-from-disk'
import type { EditorReloadDeps, EditorReloadOutcome } from './editor-reload-tab-state'
import { noteExplicitReload, runEditorReloadExclusive } from './editor-reload-in-flight'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/file-access/cross-platform-path'

const ERROR_TOAST_DURATION_MS = 8_000

/** Marks the conflict banner so a reload that finds it already showing can point the user at it. */
export const EXTERNAL_CHANGE_BANNER_FILE_ATTR = 'data-external-change-banner-file-id'

function toastId(fileId: string): string {
  return `reload-from-disk:${fileId}`
}

function relativePathOf(fileId: string): string | undefined {
  return useAppStore.getState().openFiles.find((file) => file.id === fileId)?.relativePath
}

/** A banner raised by this reload renders on a following commit; look for it for a short while. */
const BANNER_FOCUS_FRAMES = 10

/** Focus the banner itself (never one of its buttons) and pulse it once so a mouse user sees it too. */
function pointAtConflictBanner(
  fileId: string,
  scope: HTMLElement | null,
  framesLeft = BANNER_FOCUS_FRAMES
): void {
  // Only the pane the reload started in, and only while the user is still in it.
  if (!scope?.isConnected || !scope.contains(document.activeElement)) {
    return
  }
  const banner = scope.querySelector<HTMLElement>(
    `[${EXTERNAL_CHANGE_BANNER_FILE_ATTR}="${CSS.escape(fileId)}"]`
  )
  if (!banner) {
    if (framesLeft > 0) {
      requestAnimationFrame(() => pointAtConflictBanner(fileId, scope, framesLeft - 1))
    }
    return
  }
  banner.focus({ preventScroll: true })
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    banner.animate(
      [{ backgroundColor: 'rgb(245 158 11 / 0.28)' }, { backgroundColor: 'rgb(245 158 11 / 0.1)' }],
      { duration: 600, easing: 'ease-out' }
    )
  }
}

/** What the clicked control offers the reload: a status announcer and the pane its banner lives in. */
export type EditorReloadUi = {
  announce: (message: string) => void
  focusScope: HTMLElement | null
}

type ReloadFeedbackOptions = EditorReloadDeps & {
  /** Polite screen-reader announcement for outcomes no toast describes. */
  announce?: (message: string) => void
  /** The pane whose conflict banner a click may focus; absent for the palette. */
  focusScope?: HTMLElement | null
}

/** The user-facing reload: one run per file, toasts for outcomes that change nothing visible. */
export async function runEditorReloadFromDisk(
  fileId: string,
  /** The panel's current content for the tab; a getter so a later Retry sees fresh state. */
  getShown: () => FileContent | undefined,
  options: ReloadFeedbackOptions = {}
): Promise<EditorReloadOutcome | null> {
  const live = useAppStore.getState().openFiles.find((file) => file.id === fileId)
  if (live) {
    // Overtakes any silent check of this model, whichever of its tabs started it.
    noteExplicitReload(normalizeRuntimePathForComparison(live.filePath))
  }
  const outcome = await runEditorReloadExclusive(
    fileId,
    () => reloadEditorFileFromDisk(fileId, getShown(), options),
    { showSpinner: true }
  )
  if (outcome) {
    showReloadFeedback(fileId, outcome, getShown, options)
  }
  return outcome
}

function showReloadFeedback(
  fileId: string,
  outcome: EditorReloadOutcome,
  getShown: () => FileContent | undefined,
  options: ReloadFeedbackOptions
): void {
  const id = toastId(fileId)
  const description = relativePathOf(fileId)
  switch (outcome.kind) {
    case 'reloaded':
      // A Retry that worked retires the error toast it came from.
      toast.dismiss(id)
      options.announce?.(
        translate(
          'auto.components.editor.ExternalFileChangeBanner.5c02de9b31',
          'Reloaded from disk'
        )
      )
      return
    case 'deleted':
      toast.dismiss(id)
      options.announce?.(translate('editor.reloadFromDisk.fileDeleted', 'File deleted on disk'))
      return
    case 'unchanged':
      toast(translate('editor.reloadFromDisk.noChanges', 'No changes on disk'), { id, description })
      return
    case 'conflict-shown':
      pointAtConflictBanner(fileId, options.focusScope ?? null)
      return
    case 'conflict-elsewhere': {
      const { sourceTab } = outcome
      toast(translate('editor.reloadFromDisk.changedOnDisk', 'Changed on disk'), {
        id,
        description: translate(
          'editor.reloadFromDisk.editsKept',
          'Unsaved edits in {{value0}} are kept',
          { value0: basename(sourceTab.filePath) }
        ),
        action: {
          label: translate('editor.reloadFromDisk.openTab', 'Open Tab'),
          onClick: () => {
            // The source tab may live in another split group; activate its own tab there.
            const state = useAppStore.getState()
            const tab = (state.unifiedTabsByWorktree[sourceTab.worktreeId] ?? []).find(
              (entry) => entry.contentType === 'editor' && entry.entityId === sourceTab.id
            )
            if (tab) {
              state.activateTab(tab.id, { worktreeId: sourceTab.worktreeId })
            }
          }
        }
      })
      return
    }
    case 'cannot-check-dirty':
      toast(
        translate(
          'editor.reloadFromDisk.cannotCheckDirty',
          "Can't compare with disk while edits are unsaved"
        ),
        { id, description }
      )
      return
    case 'read-failed': {
      const file = useAppStore.getState().openFiles.find((tab) => tab.id === fileId)
      toast.error(
        translate('editor.reloadFromDisk.readFailed', "Couldn't read {{value0}}", {
          value0: basename(file?.filePath ?? description ?? '')
        }),
        {
          id,
          description,
          duration: ERROR_TOAST_DURATION_MS,
          action: {
            label: translate('editor.reloadFromDisk.retry', 'Retry'),
            // Retry re-resolves the live tab by id; a closed or renamed tab is skipped.
            onClick: () => void runEditorReloadFromDisk(fileId, getShown, options)
          }
        }
      )
      break
    }
    case 'skipped':
      break
  }
}
