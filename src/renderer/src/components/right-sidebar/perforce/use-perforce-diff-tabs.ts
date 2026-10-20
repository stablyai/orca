import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import { toShelvedDiffPath } from '../../../../../shared/perforce/perforce-shelved-paths'
import type {
  PerforceEntry,
  PerforceShelvedFile
} from '../../../../../shared/perforce/perforce-types'

/** Opens a workspace change, or a shelved file, of a Perforce workspace in a diff tab. */
export function usePerforceDiffTabs(worktreeId: string, worktreePath: string) {
  const openDiff = useAppStore((s) => s.openDiff)

  const openEntryDiff = (entry: PerforceEntry): void => {
    const fullPath = joinPath(worktreePath, entry.path)
    openDiff(worktreeId, fullPath, entry.path, detectLanguage(entry.path), false)
  }

  // Why: shelved views reuse the read-only "staged" diff tab, keyed by a shelf-suffixed path.
  const openShelvedFile = (
    file: PerforceShelvedFile,
    changelist: number,
    viewOnly: boolean
  ): void => {
    if (!file.path) {
      return
    }
    openDiff(
      worktreeId,
      joinPath(worktreePath, file.path),
      toShelvedDiffPath(file.path, changelist, viewOnly),
      detectLanguage(file.path),
      true
    )
  }

  return { openEntryDiff, openShelvedFile }
}
