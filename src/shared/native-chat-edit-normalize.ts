import { editFilesFromBeginPatch, unwrapBeginPatch } from './native-chat-begin-patch'
import { editLinesFromContents } from './native-chat-edit-lcs'
import {
  finalizeEditFile,
  pushEditGap,
  type NativeChatEditFile,
  type NativeChatEditLine
} from './native-chat-edit-model'
import { stripBoundedTextMarker } from './structured-agent-session-projection'
import {
  editLinesFromUnifiedPatch,
  editLinesFromWholeFile,
  unifiedPatchSections,
  type UnifiedPatchSection
} from './native-chat-unified-patch'
import type { NativeChatEditPatch } from './native-chat-types'

// `NotebookEdit` is deliberately absent: its input carries only the new cell
// source, so a card would render an unchanged cell as wholly added. It falls
// through to the generic tool view instead.
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'str_replace'])
/** Command tools, which run a patch as one of many things they can run, so a
 *  quoted envelope is not evidence that one was applied. */
const COMMAND_PATCH_TOOLS = new Set(['exec', 'shell', 'local_shell'])
/** Tools whose input may wrap a `*** Begin Patch` envelope. The dedicated patch
 *  tool applies whatever it is given; a command tool must say that it is. */
const PATCH_ENVELOPE_TOOLS = new Set(['apply_patch', ...COMMAND_PATCH_TOOLS])
/** A count standing in for a path, from a producer that joined several files'
 *  patches and kept no per-file path. */
const FILE_COUNT_PATH = /^\d+ files?$/
/** Tools whose whole payload is patch text. `Diff` reaches its patch only
 *  through the result, because the structured journal projects a diff item as a
 *  call carrying just the path. */
const PATCH_TEXT_TOOLS = new Set(['apply_patch', 'Diff'])

export function isEditToolName(name: string): boolean {
  return CLAUDE_EDIT_TOOLS.has(name) || PATCH_ENVELOPE_TOOLS.has(name) || PATCH_TEXT_TOOLS.has(name)
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Rows straight from resolved hunks, which is the only path with true numbers
 *  for a provider that reports its edits as a snippet pair. */
function linesFromEditPatch(patch: NativeChatEditPatch): NativeChatEditLine[] {
  const lines: NativeChatEditLine[] = []
  for (const hunk of patch.hunks) {
    // Hunks are separate regions of the file; run together the gutter jumps
    // from one to the next with nothing marking the skipped span.
    pushEditGap(lines)
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    for (const raw of hunk.lines) {
      if (raw.startsWith('+')) {
        lines.push({ kind: 'add', text: raw.slice(1), oldLineNumber: null, newLineNumber: newNo })
        newNo += 1
      } else if (raw.startsWith('-')) {
        lines.push({ kind: 'del', text: raw.slice(1), oldLineNumber: oldNo, newLineNumber: null })
        oldNo += 1
      } else {
        lines.push({
          kind: 'context',
          text: raw.startsWith(' ') ? raw.slice(1) : raw,
          oldLineNumber: oldNo,
          newLineNumber: newNo
        })
        oldNo += 1
        newNo += 1
      }
    }
  }
  return lines
}

/** A whole-content write looks identical whether it created the file or
 *  overwrote one, so only positive evidence may claim a creation. With no
 *  evidence either way this errs toward the weaker claim: calling a creation an
 *  edit is imprecise, while calling an overwrite a creation is false and paints
 *  an existing file as wholly new. */
const CREATED_FILE_RESULT = /^\s*File created successfully/

function wholeContentChangeKind(
  input: Record<string, unknown>,
  output: string | undefined
): 'added' | 'edited' {
  if (text(input.command) === 'create') {
    return 'added'
  }
  return output !== undefined && CREATED_FILE_RESULT.test(output) ? 'added' : 'edited'
}

/** `MultiEdit` carries its snippet pairs in `edits[]`, not at the top level. */
function multiEditFiles(input: Record<string, unknown>, path: string): NativeChatEditFile[] | null {
  if (!Array.isArray(input.edits)) {
    return null
  }
  const lines: NativeChatEditLine[] = []
  let truncated = false
  for (const entry of input.edits) {
    const edit = record(entry)
    const oldString = text(edit?.old_string) ?? text(edit?.oldString)
    const newString = text(edit?.new_string) ?? text(edit?.newString)
    if (oldString === null && newString === null) {
      continue
    }
    // Each entry is its own snippet, so it starts a new region.
    pushEditGap(lines)
    const diffed = editLinesFromContents(oldString ?? '', newString ?? '')
    lines.push(...diffed.lines)
    truncated ||= diffed.truncated
  }
  if (lines.length === 0) {
    return null
  }
  return [
    finalizeEditFile({
      path,
      oldPath: null,
      changeKind: 'edited',
      lines,
      // A snippet pair cannot say where in the file it sits.
      lineNumbersKnown: false,
      truncated
    })
  ]
}

function claudeEditFiles(
  name: string,
  input: Record<string, unknown>,
  output: string | undefined
): NativeChatEditFile[] | null {
  const path = text(input.file_path) ?? text(input.path) ?? 'file'
  if (name === 'MultiEdit') {
    return multiEditFiles(input, path)
  }
  const oldString = text(input.old_string) ?? text(input.oldString)
  const newString = text(input.new_string) ?? text(input.newString)
  const content = text(input.content) ?? text(input.file_text)
  if (oldString === null && content !== null) {
    const whole = editLinesFromWholeFile(content, 'add')
    return [
      finalizeEditFile({
        path,
        oldPath: null,
        changeKind: wholeContentChangeKind(input, output),
        lines: whole.lines,
        lineNumbersKnown: true,
        truncated: whole.truncated
      })
    ]
  }
  if (oldString === null && newString === null) {
    return null
  }
  const diffed = editLinesFromContents(oldString ?? '', newString ?? content ?? '')
  return [
    finalizeEditFile({
      path,
      oldPath: null,
      changeKind: 'edited',
      lines: diffed.lines,
      // A snippet pair cannot say where in the file it sits.
      lineNumbersKnown: false,
      truncated: diffed.truncated
    })
  ]
}

/** A move is appended to the patch body as prose rather than a header field, on
 *  every lane that carries the body as text. Left in place it renders as a
 *  numbered line of the file it moved.
 *
 *  Anchored to the start of the final line: unanchored, a row whose own content
 *  mentions a move was cut in half and the file it names claimed as a rename
 *  that never happened. */
const MOVE_MARKER = /(?:^|\n)Moved to: (.+)$/

function splitMoveMarker(patch: string): { body: string; movedTo: string | null } {
  const match = MOVE_MARKER.exec(patch)
  return match
    ? { body: patch.slice(0, match.index), movedTo: match[1]!.trim() }
    : { body: patch, movedTo: null }
}

function codexChangeFiles(changes: unknown[]): NativeChatEditFile[] {
  return changes.flatMap((entry) => {
    const change = record(entry)
    const path = text(change?.path)
    const diff = text(change?.diff)
    if (!change || !path || !diff) {
      return []
    }
    const kind = record(change.kind)
    const kindType = text(kind?.type) ?? text(change.kind) ?? 'update'
    const movePath = text(kind?.move_path) ?? text(change.movePath)
    if (kindType === 'add' || kindType === 'delete') {
      // Add and delete arrive as raw file content, with no hunk header or signs.
      const whole = editLinesFromWholeFile(diff, kindType === 'add' ? 'add' : 'del')
      return [
        finalizeEditFile({
          path,
          oldPath: null,
          changeKind: kindType === 'add' ? 'added' : 'deleted',
          lines: whole.lines,
          lineNumbersKnown: true,
          truncated: whole.truncated
        })
      ]
    }
    const parsed = editLinesFromUnifiedPatch(splitMoveMarker(diff).body)
    if (!parsed) {
      return []
    }
    return [
      finalizeEditFile({
        path: movePath ?? path,
        oldPath: movePath ? path : null,
        changeKind: movePath ? 'renamed' : 'edited',
        lines: parsed.lines,
        lineNumbersKnown: parsed.lineNumbersKnown,
        truncated: parsed.truncated
      })
    ]
  })
}

/** One diff model for a tool call and its result, across every shape the
 *  supported agents use to report a file edit. */
export function editFilesFromToolPair(pair: {
  name: string
  input: unknown
  /** Provider lifecycle for the call, when the lane reports one. */
  state?: 'running' | 'completed' | 'failed'
  result?: { output?: string; isError?: boolean; editPatch?: NativeChatEditPatch }
}): NativeChatEditFile[] | null {
  // A card states the edit as made, so it takes evidence that it landed: the
  // provider reporting the call complete, or a result that is not an error.
  // Anything else — failed, still running, or a turn that stopped before the
  // call was answered — keeps the generic tool view and its error body.
  if (pair.state === 'failed' || pair.state === 'running' || pair.result?.isError === true) {
    return null
  }
  if (pair.state !== 'completed' && pair.result === undefined) {
    return null
  }
  const input = record(pair.input)
  const patch = pair.result?.editPatch
  if (patch && patch.hunks.length > 0) {
    return [
      finalizeEditFile({
        path: patch.filePath ?? text(input?.file_path) ?? 'file',
        oldPath: null,
        changeKind: 'edited',
        lines: linesFromEditPatch(patch),
        lineNumbersKnown: true
      })
    ]
  }

  // Only a tool that runs a patch may be searched for an envelope: a file's own
  // contents can quote one, and scanning a write's payload rendered a card for
  // the quoted file while the file actually written never appeared.
  if (PATCH_ENVELOPE_TOOLS.has(pair.name)) {
    const envelope = unwrapBeginPatch(pair.input, {
      requireApplyCommand: COMMAND_PATCH_TOOLS.has(pair.name)
    })
    const files = envelope ? editFilesFromBeginPatch(envelope) : []
    if (files.length > 0) {
      return files
    }
  }

  if (input && Array.isArray(input.changes)) {
    const files = codexChangeFiles(input.changes)
    if (files.length > 0) {
      return files
    }
  }

  if (input && CLAUDE_EDIT_TOOLS.has(pair.name)) {
    return claudeEditFiles(pair.name, input, pair.result?.output)
  }

  if (!PATCH_TEXT_TOOLS.has(pair.name)) {
    return null
  }
  // The result fallback is scoped to `Diff`, whose call carries only a path.
  // Reading any command tool's output as a patch reclassified `git diff` as a
  // file edit and swallowed the command line with it.
  const patchText =
    text(input?.patch) ?? text(input?.diff) ?? (pair.name === 'Diff' ? pair.result?.output : null)
  if (!patchText) {
    return null
  }
  // The body carries its own marker when the journal clipped it. Read as
  // content it becomes a numbered line of the file, and the rows that follow
  // are reported complete.
  const bounded = stripBoundedTextMarker(patchText)
  const moved = splitMoveMarker(bounded.text)
  // One card per file the patch touches: run together, the later files' rows
  // and gutter numbers sit under the first file's name.
  const split = unifiedPatchSections(moved.body)
  const callerPath = text(input?.path) ?? text(input?.file_path)
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
    const parsed = editLinesFromUnifiedPatch(section.body)
    if (!parsed && section.path === null) {
      return []
    }
    return [
      finalizeEditFile({
        path: named(section),
        oldPath: section.oldPath,
        changeKind: section.changeKind,
        lines: parsed?.lines ?? [],
        lineNumbersKnown: parsed?.lineNumbersKnown ?? false,
        truncated: bounded.truncated || split.truncated || (parsed?.truncated ?? false)
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
