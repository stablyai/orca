import { normalizeRuntimePathForComparison } from '../../../../../shared/file-access/cross-platform-path'

type ConflictWatch = { reported: boolean }

// Only files with a disk read in flight are tracked, so a long session keeps nothing per path.
const watchesByPath = new Map<string, Set<ConflictWatch>>()

/** Records a changed-on-disk / refused-save / external-change report for a file (unknown file: all files). */
export function noteEditorConflictReport(filePath: string | undefined): void {
  const sets = filePath
    ? [watchesByPath.get(normalizeRuntimePathForComparison(filePath))]
    : [...watchesByPath.values()]
  for (const watch of sets.flatMap((set) => (set ? [...set] : []))) {
    watch.reported = true
  }
}

/** Starts listening for reports on `filePath` for the length of one disk read; always `stop()` it. */
export function watchEditorConflictReports(filePath: string): {
  reported: () => boolean
  stop: () => void
} {
  const key = normalizeRuntimePathForComparison(filePath)
  const watch: ConflictWatch = { reported: false }
  const set = watchesByPath.get(key) ?? new Set<ConflictWatch>()
  set.add(watch)
  watchesByPath.set(key, set)
  return {
    reported: () => watch.reported,
    stop: () => {
      set.delete(watch)
      if (set.size === 0 && watchesByPath.get(key) === set) {
        watchesByPath.delete(key)
      }
    }
  }
}
