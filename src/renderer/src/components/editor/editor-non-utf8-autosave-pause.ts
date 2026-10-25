import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { normalizeAbsolutePathForComparison } from '@/components/right-sidebar/file-explorer-paths'
import type { OpenFile } from '@/store/slices/editor'

type PausedFile = Pick<OpenFile, 'filePath' | 'runtimeEnvironmentId'>

// Why: autosave must not convert a non-UTF-8 file unasked; a confirmed explicit save lifts the pause.
const pausedFiles = new Set<string>()

function pauseKey(file: PausedFile): string {
  return `${file.runtimeEnvironmentId?.trim() || 'client'}::${normalizeAbsolutePathForComparison(file.filePath)}`
}

export function isAutosavePausedForNonUtf8File(file: PausedFile): boolean {
  return pausedFiles.size > 0 && pausedFiles.has(pauseKey(file))
}

/** Tells the user once per pause, so a refused autosave never repeats as a loop of notices. */
export function pauseAutosaveForNonUtf8File(file: PausedFile): void {
  const key = pauseKey(file)
  if (pausedFiles.has(key)) {
    return
  }
  pausedFiles.add(key)
  toast.warning(
    translate(
      'auto.components.editor.editor.save.notUtf8.notice',
      "Autosave is paused for {{name}} because it isn't UTF-8 text. Saving it yourself rewrites it as UTF-8 and replaces any characters that aren't valid UTF-8.",
      { name: basename(file.filePath) }
    )
  )
}

export function resumeAutosaveForNonUtf8File(file: PausedFile): void {
  pausedFiles.delete(pauseKey(file))
}

/** Why: a close, reload or discard ends the edits the pause held back, so the next edit asks the host again. */
export function releaseNonUtf8PausesWithoutDirtyTab(
  openFiles: readonly (PausedFile & Pick<OpenFile, 'isDirty'>)[]
): void {
  if (pausedFiles.size === 0) {
    return
  }
  const dirty = new Set(openFiles.filter((file) => file.isDirty).map(pauseKey))
  for (const key of pausedFiles) {
    if (!dirty.has(key)) {
      pausedFiles.delete(key)
    }
  }
}

export function __clearNonUtf8AutosavePausesForTests(): void {
  pausedFiles.clear()
}
