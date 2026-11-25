import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { AppState } from '@/store/types'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { joinPath } from '@/lib/path'
import {
  findOtherSpellingTab,
  isOnlyListedSpelling,
  type OtherSpellingTabState
} from './listed-spelling-tab'

export function openUncommittedEntry(
  state: Pick<AppState, 'trackConflictPath' | 'openConflictFile' | 'openFile' | 'openDiff'> &
    OtherSpellingTabState,
  worktreeId: string,
  worktreePath: string,
  entry: GitStatusEntry,
  options: Parameters<AppState['openDiff']>[5] = {}
): void {
  const language = detectLanguage(entry.path)
  if (entry.conflictKind && entry.conflictStatus) {
    if (entry.conflictStatus === 'unresolved') {
      state.trackConflictPath(worktreeId, entry.path, entry.conflictKind)
    }
    state.openConflictFile(worktreeId, worktreePath, entry, language, options)
    return
  }
  const filePath = joinPath(worktreePath, entry.path)
  if (
    language === 'markdown' &&
    entry.area !== 'staged' &&
    (entry.status === 'added' || entry.status === 'untracked')
  ) {
    const openEdit = (target: { filePath: string; relativePath: string }): void => {
      state.openFile(
        {
          filePath: target.filePath,
          relativePath: target.relativePath,
          worktreeId,
          language,
          mode: 'edit',
          runtimeEnvironmentId: options.runtimeEnvironmentId
        },
        options
      )
    }
    const asReported = { filePath, relativePath: entry.path }
    const other = findOtherSpellingTab(
      state,
      worktreeId,
      worktreePath,
      entry.path,
      options.runtimeEnvironmentId
    )
    if (!other) {
      openEdit(asReported)
      return
    }
    // Why: Git reports a macOS name composed (NFC) that the explorer opened as stored (NFD).
    // Reuse that tab only when the listing shows it is the one file under this name.
    void isOnlyListedSpelling(worktreePath, other.relativePath, entry.path)
      .catch(() => false)
      .then((onlyListed) => openEdit(onlyListed ? other : asReported))
    return
  }
  state.openDiff(worktreeId, filePath, entry.path, language, entry.area === 'staged', {
    ...options,
    ...(entry.area === 'staged' && entry.status === 'renamed' ? { oldPath: entry.oldPath } : {})
  })
}
