import { isLocalMacDesktopClient } from '@/app-shell/chrome/desktop-window-chrome'
import { joinPath } from '@/lib/path'
import { getConnectionIdForFileFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { AppState } from '@/store/types'

// Code units below U+0300 never change under NFC, so ASCII and Latin-1 paths skip normalize().
const MAY_CHANGE_UNDER_NFC = /[\u0300-\uffff]/

export type OtherSpellingTabState = Pick<
  AppState,
  'openFiles' | 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
>

/** A local edit tab for this path under another Unicode spelling; null when the path itself is open. */
export function findOtherSpellingTab(
  state: OtherSpellingTabState,
  worktreeId: string,
  worktreePath: string,
  relativePath: string,
  runtimeEnvironmentId: string | null | undefined
): OpenFile | null {
  if (
    !isLocalMacDesktopClient() ||
    runtimeEnvironmentId ||
    !MAY_CHANGE_UNDER_NFC.test(relativePath) ||
    getConnectionIdForFileFromState(state, worktreeId, joinPath(worktreePath, relativePath)) !==
      null
  ) {
    return null
  }
  const composed = relativePath.normalize('NFC')
  let other: OpenFile | null = null
  for (const file of state.openFiles) {
    if (
      file.worktreeId !== worktreeId ||
      file.mode !== 'edit' ||
      file.runtimeEnvironmentId ||
      file.externalSshTargetId?.trim()
    ) {
      continue
    }
    if (file.relativePath === relativePath) {
      return null
    }
    if (
      !other &&
      file.relativePath.normalize('NFC') === composed &&
      file.filePath === joinPath(worktreePath, file.relativePath)
    ) {
      other = file
    }
  }
  return other
}

/**
 * Whether the directory listing shows `listed`, and not `requested`, at each segment where the two
 * spellings differ. Why: a mount that keeps NFC and NFD names as separate files lists both, and
 * two files must never share a tab.
 */
export async function isOnlyListedSpelling(
  worktreePath: string,
  listed: string,
  requested: string
): Promise<boolean> {
  const listedParts = listed.split('/')
  const requestedParts = requested.split('/')
  if (listedParts.length !== requestedParts.length) {
    return false
  }
  for (let index = 0; index < listedParts.length; index++) {
    if (listedParts[index] === requestedParts[index]) {
      continue
    }
    const dirPath =
      index === 0 ? worktreePath : joinPath(worktreePath, listedParts.slice(0, index).join('/'))
    const names = new Set((await window.api.fs.readDir({ dirPath })).map((entry) => entry.name))
    if (!names.has(listedParts[index]) || names.has(requestedParts[index])) {
      return false
    }
  }
  return true
}
