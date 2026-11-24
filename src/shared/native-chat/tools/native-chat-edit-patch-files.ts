import { finalizeEditFile, type NativeChatEditFile } from './native-chat-edit-model'
import { stripBoundedTextMarker } from '../../agent-session/view/structured-agent-session-projection'
import {
  editLinesFromUnifiedPatch,
  summarizeUnifiedPatch,
  unifiedPatchSections,
  type UnifiedPatchSection
} from './native-chat-unified-patch'

const FILE_COUNT_PATH = /^\d+ files?$/

/** Codex reports a change to several files under the path `N files`, which names no file. */
export function isNativeChatFileCountPath(path: string): boolean {
  return FILE_COUNT_PATH.test(path)
}

/** Strip only final-line Moved to prose. Unanchored matching truncates literal file content and invents renames. */
const MOVE_MARKER = /(?:^|\n)Moved to: (.+)$/

/** `join('\n')` between diffs that already end in a newline. Hunks inside one file stay adjacent. */
const JOINED_FILE_DIFF = /\n\n(?=@@|diff --git |--- )/

function filesForFileCountPath(
  patchText: string,
  countedPaths: readonly string[] | null,
  summaryOnly: boolean
): NativeChatEditFileSummary[] | null {
  const body = splitMoveMarker(stripBoundedTextMarker(patchText).text).body
  if (unifiedPatchSections(body).sections.some((section) => section.path !== null)) {
    return summaryOnly
      ? editFilesFromPatchText(patchText, null, true)
      : editFilesFromPatchText(patchText, null)
  }
  const parts = splitCountedFileDiffs(body, countedPaths)
  if (!parts) {
    return null
  }
  const files = parts.flatMap((part) =>
    summaryOnly
      ? (editFilesFromPatchText(part.diff, part.path, true) ?? [])
      : (editFilesFromPatchText(part.diff, part.path) ?? [])
  )
  return files.length > 0 ? files : null
}

function splitCountedFileDiffs(
  patch: string,
  paths: readonly string[] | null
): { path: string; diff: string }[] | null {
  if (!paths || paths.length < 2) {
    return null
  }
  const blankParts = patch.split(JOINED_FILE_DIFF).filter((part) => part.trim() !== '')
  if (blankParts.length === paths.length) {
    return blankParts.map((diff, index) => ({ path: paths[index]!, diff }))
  }
  const hunks = patch
    .split(/\n(?=@@)/)
    .map((part) => part.trim())
    .filter((part) => part.startsWith('@@'))
  if (hunks.length === paths.length) {
    return hunks.map((diff, index) => ({ path: paths[index]!, diff }))
  }
  return null
}

export function splitMoveMarker(patch: string): { body: string; movedTo: string | null } {
  const match = MOVE_MARKER.exec(patch)
  return match
    ? { body: patch.slice(0, match.index), movedTo: match[1]!.trim() }
    : { body: patch, movedTo: null }
}

export type NativeChatEditFileSummary = Pick<
  NativeChatEditFile,
  'path' | 'oldPath' | 'changeKind' | 'added' | 'removed' | 'truncated'
>

export function editFilesFromPatchText(
  patchText: string,
  callerPath: string | null,
  summaryOnly?: false,
  countedPaths?: readonly string[] | null
): NativeChatEditFile[] | null
export function editFilesFromPatchText(
  patchText: string,
  callerPath: string | null,
  summaryOnly: true,
  countedPaths?: readonly string[] | null
): NativeChatEditFileSummary[] | null
export function editFilesFromPatchText(
  patchText: string,
  callerPath: string | null,
  summaryOnly = false,
  countedPaths: readonly string[] | null = null
): NativeChatEditFileSummary[] | null {
  if (callerPath !== null && isNativeChatFileCountPath(callerPath)) {
    // A count names no file. Headers in the patch do; otherwise the journal's paths list does.
    return filesForFileCountPath(patchText, countedPaths, summaryOnly)
  }
  // Strip journal truncation markers so they cannot become numbered content or imply a complete patch.
  const bounded = stripBoundedTextMarker(patchText)
  const moved = splitMoveMarker(bounded.text)
  // Separate files into cards so later rows never inherit the first file’s name.
  const split = unifiedPatchSections(moved.body)
  // Caller path wins for single-file patches; multiple files/rename destinations require headers. Ignore unnamed preambles when counting files.
  const namedSections = split.sections.filter((section) => section.path !== null).length
  const named = (section: UnifiedPatchSection): string =>
    (namedSections <= 1 && section.oldPath === null
      ? (callerPath ?? section.path)
      : (section.path ?? callerPath)) ?? 'file'
  const files = split.sections.flatMap((section) => {
    const parsed = summaryOnly
      ? summarizeUnifiedPatch(section.body)
      : editLinesFromUnifiedPatch(section.body)
    if (!parsed && section.path === null) {
      return []
    }
    const metadata = {
      path: named(section),
      oldPath: section.oldPath,
      changeKind: section.changeKind,
      truncated: bounded.truncated || split.truncated || (parsed?.truncated ?? false)
    }
    return [
      summaryOnly
        ? {
            ...metadata,
            added: parsed && 'added' in parsed ? parsed.added : 0,
            removed: parsed && 'removed' in parsed ? parsed.removed : 0
          }
        : finalizeEditFile({
            ...metadata,
            lines: parsed && 'lines' in parsed ? parsed.lines : [],
            lineNumbersKnown:
              parsed && 'lineNumbersKnown' in parsed ? parsed.lineNumbersKnown : false
          })
    ]
  })
  // The move marker names where the whole patch moved, so it can only speak for
  // a patch describing one file.
  if (moved.movedTo !== null && files.length === 1 && files[0]) {
    const only = files[0]
    return [{ ...only, path: moved.movedTo, oldPath: only.path, changeKind: 'renamed' }]
  }
  return files.length > 0 ? files : null
}
