import type { FileDiffMetadata } from '@pierre/diffs'
import type { EditorFactory } from '@pierre/diffs/react'
import { Editor, EditStateManager, type EditorOptions } from '@pierre/diffs/edit'
import type { PierreDiffAnnotationData } from './pierre-diff-comment-annotations'
import { getPierreNativeView } from './pierre-diff-native-view-state'

type StateRequest = { scope: string; fileDiff: FileDiffMetadata }
const requests = new WeakMap<object, StateRequest>()
const active = new Set<string>()
const dormant = new Map<string, number>()
const MAX_DORMANT_SESSIONS = 32
const MAX_RETAINED_CHARACTERS = 16_000_000
let retainedCharacters = 0
let duplicateId = 0

export function withPierreDiffEditState(
  options: EditorOptions<'file-diff', PierreDiffAnnotationData, undefined>,
  scope: string | undefined,
  fileDiff: FileDiffMetadata
) {
  if (scope) {
    requests.set(options, { scope, fileDiff })
  }
  return options
}

function forgetDormant(key: string): void {
  retainedCharacters -= dormant.get(key) ?? 0
  dormant.delete(key)
}

function retainDormant(key: string): void {
  forgetDormant(key)
  const state = EditStateManager.get('file-diff', key)
  if (!state) {
    return
  }
  let characters = state.document.getText().length
  for (const line of state.diffSession.oldFile?.lines ?? []) {
    characters += line.length
  }
  for (const entry of [...state.document.history.undoStack, ...state.document.history.redoStack]) {
    for (const edit of [...entry.forwardEdits, ...entry.inverseEdits]) {
      characters += edit.text.length
    }
  }
  dormant.set(key, characters)
  retainedCharacters += characters
  while (dormant.size > MAX_DORMANT_SESSIONS || retainedCharacters > MAX_RETAINED_CHARACTERS) {
    const oldest = dormant.keys().next().value!
    forgetDormant(oldest)
    EditStateManager.clear('file-diff', oldest)
  }
}

export const createPierreEditor: EditorFactory<PierreDiffAnnotationData, undefined> = (
  editorType,
  options,
  editStateKey
) => {
  const request = requests.get(options)
  if (editorType !== 'file-diff' || !request) {
    return new Editor(editorType, options, editStateKey)
  }
  const { scope, fileDiff } = request
  const duplicate = active.has(scope)
  const key = duplicate ? `${scope}:concurrent:${++duplicateId}` : scope
  forgetDormant(key)
  const stored = EditStateManager.get('file-diff', key)
  const matchesContent = stored?.document.getText() === fileDiff.additionLines.join('')
  // Pierre resumes an edited document only from a complete EditState; dropping diffSession
  // makes it rebuild and drop the restored selection. Keep it when the old side is unchanged,
  // otherwise fall back to fresh worker-computed hunks.
  // Only one layer may drive selection. The native layer saves exactly the selections it intends
  // to restore (it skips the editable additions side), so any saved selection means it owns the
  // restore and the editor must get a rebuilt session rather than reassert its own.
  const nativeOwnsSelection = getPierreNativeView(key)?.selection != null
  // Must be at least as strict as Pierre's canRestoreDiffSession (FileDiff.js): it THROWS on a
  // retained session that cannot resume against the delivered old file, so a looser predicate
  // here would manufacture the very error this preservation exists to avoid.
  const oldFile = stored?.diffSession?.oldFile
  const resumableOldSide =
    oldFile == null
      ? fileDiff.type === 'new'
      : fileDiff.type !== 'new' &&
        oldFile.name === (fileDiff.prevName ?? fileDiff.name) &&
        oldFile.lines.length === fileDiff.deletionLines.length &&
        oldFile.lines.every((line, index) => line === fileDiff.deletionLines[index])
  const matchesOldSide = matchesContent && !nativeOwnsSelection && resumableOldSide
  const restored = matchesOldSide
    ? stored
    : matchesContent
      ? { ...stored, diffSession: undefined }
      : undefined
  if (stored && !matchesContent) {
    EditStateManager.clear('file-diff', key)
  }
  active.add(key)
  try {
    const editor = new Editor(
      editorType,
      {
        ...options,
        initialState: options.initialState ?? (restored as typeof options.initialState),
        onComplete: (event) => {
          active.delete(key)
          if (duplicate) {
            EditStateManager.clear('file-diff', key)
          } else {
            retainDormant(key)
          }
          options.onComplete?.(event)
        }
      },
      key
    )
    const edit = editor.edit.bind(editor)
    editor.edit = (instance) => {
      try {
        return edit(instance)
      } catch (error) {
        active.delete(key)
        throw error
      }
    }
    return editor
  } catch (error) {
    active.delete(key)
    throw error
  }
}
