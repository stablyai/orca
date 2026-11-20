import { relativePathInsideRoot } from '../../../../shared/file-access/cross-platform-path'
import type {
  FsChangeEvent,
  FsChangedPayload
} from '../../../../shared/file-watch/filesystem-change-event'
import type { GitDiffResult } from '../../../../shared/git/diff/git-diff-compare-types'
import { editLinesFromContents } from '../../../../shared/native-chat/tools/native-chat-edit-lcs'
import {
  finalizeEditFile,
  pushEditGap,
  type NativeChatEditChangeKind,
  type NativeChatEditFile,
  type NativeChatEditLine
} from '../../../../shared/native-chat/tools/native-chat-edit-model'
import type { NativeChatTurnDiff } from '../../../../shared/native-chat/tools/native-chat-turn-diffs'

/** Files a turn's watcher diff never attributes to the agent. */
const WATCHED_DIFF_EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules'])
/** Resolved per-file diffs kept per turn; a long turn stays bounded. */
export const MAX_WATCHED_DIFF_FILES_PER_TURN = 100
/** Context rows kept around each change so settled cards stay scannable. */
export const WATCHED_DIFF_CONTEXT_LINES = 3

export type WatchedTurnFilePatch = { file: NativeChatEditFile }

export type WatchedTurnDiffFile = {
  path: string
  added: number
  removed: number
  truncated: boolean
  patches: WatchedTurnFilePatch[]
}

export type WatchedTurnDiff = {
  files: WatchedTurnDiffFile[]
  added: number
  removed: number
  truncated: boolean
}

/** Agent sessions share one worktree, so a watcher sees every pane's writes. */
export type MergedNativeChatTurnDiff = {
  files: (NativeChatTurnDiff['files'][number] | WatchedTurnDiffFile)[]
  added: number
  removed: number
  truncated: boolean
}

export function isWatchedTurnDiffFile(
  file: MergedNativeChatTurnDiff['files'][number]
): file is WatchedTurnDiffFile {
  return 'patches' in file
}

/** Paths the watcher reported inside the worktree, minus directories and
 *  segments that never carry agent-authored edits. An overflow event means the
 *  watcher's buffer dropped events, so the caller should re-diff every path it
 *  already touched rather than trust this list. */
export function watchedFilePathsFromFsPayload(
  payload: FsChangedPayload,
  worktreePath: string
): { paths: string[]; overflow: boolean } {
  const paths = new Set<string>()
  let overflow = payload.resync === true
  for (const event of payload.events) {
    if (event.kind === 'overflow') {
      overflow = true
      continue
    }
    if (event.isDirectory === true) {
      continue
    }
    for (const absolutePath of [event.absolutePath, event.oldAbsolutePath]) {
      if (!absolutePath) {
        continue
      }
      const relative = relativePathInsideRoot(worktreePath, absolutePath)
      if (relative === null || relative === '' || hasExcludedSegment(relative)) {
        continue
      }
      paths.add(relative)
    }
  }
  return { paths: Array.from(paths), overflow }
}

function hasExcludedSegment(relativePath: string): boolean {
  for (const segment of relativePath.split(/[\\/]/)) {
    if (WATCHED_DIFF_EXCLUDED_SEGMENTS.has(segment)) {
      return true
    }
  }
  return false
}

function changeKindForEvent(
  kind: FsChangeEvent['kind'] | undefined,
  originalEmpty: boolean,
  modifiedEmpty: boolean
): NativeChatEditChangeKind {
  if (kind === 'delete' || (modifiedEmpty && !originalEmpty)) {
    return 'deleted'
  }
  if (kind === 'create' || kind === 'rename' || originalEmpty) {
    return 'added'
  }
  return 'edited'
}

/** Whole-file diff rows keep their numbers; long unchanged stretches collapse
 *  to gap rows so settled cards stay scannable. */
function collapseContextLines(
  lines: readonly NativeChatEditLine[],
  contextLines: number
): NativeChatEditLine[] {
  const keep = Array.from({ length: lines.length }, () => false)
  for (const [index, line] of lines.entries()) {
    if (line.kind !== 'context') {
      for (
        let row = Math.max(0, index - contextLines);
        row <= Math.min(lines.length - 1, index + contextLines);
        row += 1
      ) {
        keep[row] = true
      }
    }
  }
  const collapsed: NativeChatEditLine[] = []
  for (const [index, line] of lines.entries()) {
    if (keep[index]) {
      collapsed.push(line)
    } else {
      pushEditGap(collapsed)
    }
  }
  // Edge gaps stay: they tell the reader the file continues past the shown
  // region rather than the diff covering lines 1..N.
  return collapsed
}

/** Convert a settled `git.diff` result into the card shape the transcript
 *  already renders for tool edits. Binary diffs have no line content, so the
 *  caller drops them. */
export function watchedEditFileFromGitDiff(
  path: string,
  diff: GitDiffResult,
  eventKind?: FsChangeEvent['kind'],
  contextLines: number = WATCHED_DIFF_CONTEXT_LINES
): NativeChatEditFile | null {
  if (diff.kind !== 'text') {
    return null
  }
  const originalEmpty = diff.originalContent.length === 0
  const modifiedEmpty = diff.modifiedContent.length === 0
  const { lines, truncated } = editLinesFromContents(diff.originalContent, diff.modifiedContent)
  return finalizeEditFile({
    path,
    oldPath: null,
    changeKind: changeKindForEvent(eventKind, originalEmpty, modifiedEmpty),
    lines: collapseContextLines(lines, contextLines),
    lineNumbersKnown: true,
    truncated
  })
}

/** Fold one resolved file into a turn's watched-diff accumulation. */
export function watchedTurnDiffWithFile(
  diff: WatchedTurnDiff | undefined,
  file: NativeChatEditFile
): WatchedTurnDiff {
  const files = diff ? [...diff.files] : []
  const existing = files.findIndex((entry) => entry.path === file.path)
  const entry: WatchedTurnDiffFile = {
    path: file.path,
    added: file.added,
    removed: file.removed,
    truncated: file.truncated,
    patches: [{ file }]
  }
  if (existing !== -1) {
    files[existing] = entry
  } else {
    files.push(entry)
  }
  return {
    files,
    added: files.reduce((sum, entry2) => sum + entry2.added, 0),
    removed: files.reduce((sum, entry2) => sum + entry2.removed, 0),
    truncated: files.some((entry2) => entry2.truncated)
  }
}

/** Tool-call diffs win per path; watcher rows fill paths no tool card named. */
export function mergeNativeChatTurnDiffs(
  observed: NativeChatTurnDiff | undefined,
  watched: WatchedTurnDiff | undefined
): MergedNativeChatTurnDiff | undefined {
  if (!observed && !watched) {
    return undefined
  }
  const observedPaths = new Set(observed?.files.map((file) => file.path) ?? [])
  const watchedFiles = (watched?.files ?? []).filter((file) => !observedPaths.has(file.path))
  const files: MergedNativeChatTurnDiff['files'] = [...(observed?.files ?? []), ...watchedFiles]
  if (files.length === 0) {
    return undefined
  }
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    truncated: observed?.truncated === true || watched?.truncated === true
  }
}
