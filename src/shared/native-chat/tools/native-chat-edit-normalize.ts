import { editFilesFromBeginPatch, unwrapBeginPatch } from './native-chat-begin-patch'
import { editLinesFromContents } from './native-chat-edit-lcs'
import {
  finalizeEditFile,
  pushEditGap,
  type NativeChatEditFile,
  type NativeChatEditLine
} from './native-chat-edit-model'
import { editFilesFromPatchText, splitMoveMarker } from './native-chat-edit-patch-files'
import { editLinesFromUnifiedPatch, editLinesFromWholeFile } from './native-chat-unified-patch'
import type { NativeChatEditPatch } from '../../native-chat-types'

// NotebookEdit has only new cell text; diff cards would falsely mark unchanged cells added. Keep the generic view.
const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'str_replace'])
/** Command tools can quote patches without applying them. */
const COMMAND_PATCH_TOOLS = new Set(['exec', 'shell', 'local_shell'])
/** Dedicated patch tools apply their envelope; general command tools must explicitly apply it. */
const PATCH_ENVELOPE_TOOLS = new Set(['apply_patch', ...COMMAND_PATCH_TOOLS])
/** Diff carries patch text only in its result; its journal call contains just a path. */
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

/** Resolved hunks provide true file positions for snippet-pair providers. */
function linesFromEditPatch(patch: NativeChatEditPatch): NativeChatEditLine[] {
  const lines: NativeChatEditLine[] = []
  for (const hunk of patch.hunks) {
    // Separate hunks with gaps so skipped file regions remain visible.
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

/** Whole-file writes do not prove creation. Require positive evidence; falsely calling an overwrite new misrepresents every existing line. */
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

export function editFilesFromToolPair(pair: {
  name: string
  input: unknown
  /** Provider lifecycle for the call, when the lane reports one. */
  state?: 'running' | 'completed' | 'failed'
  result?: { output?: string; isError?: boolean; editPatch?: NativeChatEditPatch }
}): NativeChatEditFile[] | null {
  // Cards assert a landed edit: require completed lifecycle or a non-error result.
  // Failed/running/unanswered calls retain generic tool/error views.
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

  // Search envelopes only in eligible patch tools; Write payloads can quote unrelated patches and would hide the file actually written.
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
  // Only Diff falls back to result text; treating command output as patches would turn git diff reads into edits and hide commands.
  const patchText =
    text(input?.patch) ?? text(input?.diff) ?? (pair.name === 'Diff' ? pair.result?.output : null)
  if (!patchText) {
    return null
  }
  return editFilesFromPatchText(patchText, text(input?.path) ?? text(input?.file_path))
}
