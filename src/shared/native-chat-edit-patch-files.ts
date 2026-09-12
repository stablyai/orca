import { finalizeEditFile, type NativeChatEditFile } from './native-chat-edit-model'
import { stripBoundedTextMarker } from './structured-agent-session-projection'
import {
  editLinesFromUnifiedPatch,
  summarizeUnifiedPatch,
  unifiedPatchSections,
  type UnifiedPatchSection
} from './native-chat-unified-patch'

const FILE_COUNT_PATH = /^\d+ files?$/

/** A move is appended to the patch body as prose rather than a header field, on
 *  every lane that carries the body as text. Left in place it renders as a
 *  numbered line of the file it moved.
 *
 *  Anchored to the start of the final line: unanchored, a row whose own content
 *  mentions a move was cut in half and the file it names claimed as a rename
 *  that never happened. */
const MOVE_MARKER = /(?:^|\n)Moved to: (.+)$/

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
  callerPath: string | null
): NativeChatEditFile[] | null
export function editFilesFromPatchText(
  patchText: string,
  callerPath: string | null,
  summaryOnly: true
): NativeChatEditFileSummary[] | null
export function editFilesFromPatchText(
  patchText: string,
  callerPath: string | null,
  summaryOnly = false
): NativeChatEditFileSummary[] | null {
  // The body carries its own marker when the journal clipped it. Read as
  // content it becomes a numbered line of the file, and the rows that follow
  // are reported complete.
  const bounded = stripBoundedTextMarker(patchText)
  const moved = splitMoveMarker(bounded.text)
  // One card per file the patch touches: run together, the later files' rows
  // and gutter numbers sit under the first file's name.
  const split = unifiedPatchSections(moved.body)
  if (callerPath !== null && FILE_COUNT_PATH.test(callerPath)) {
    // The producer joined several files' patches and kept a count in place of a
    // path, so nothing here can name a file. Naming the card after the count
    // would assert a file that does not exist.
    return null
  }
  // A patch that names one file is the file the call is reporting on, so the
  // call's own path wins — it is the provider's, where the header's is relative
  // to the patch. A patch naming several has no one path, and a rename's
  // destination is only ever in the header. Sections that name nothing are
  // preamble and must not change that count.
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
