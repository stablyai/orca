import type { OnMount } from '@monaco-editor/react'
import type { CancellationToken, IDisposable, editor } from 'monaco-editor'
import {
  INLINE_COMPLETION_PREFIX_MAX_CHARS,
  INLINE_COMPLETION_SUFFIX_MAX_CHARS
} from '../../../../../shared/plugins/events/plugin-hook-payloads'
import { pluginEditorHookWanted } from '../plugin-editor-hook-wanted'

type MonacoApi = Parameters<OnMount>[1]

const INLINE_COMPLETION_HOOK = 'editor.inlineCompletion'
// Why: Monaco asks on every keystroke; wait for a pause so plugins are not hit per character.
const INLINE_COMPLETION_PAUSE_MS = 300

export type InlineCompletionModelInfo = {
  workspaceId: string | null
  path: string
  getLanguageId: () => string
  isReadOnly: () => boolean
}

let provider: IDisposable | null = null
let providerMonaco: MonacoApi = null
const infoByModel = new WeakMap<editor.ITextModel, InlineCompletionModelInfo>()

function pausedWithoutCancel(token: CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancelSub = token.onCancellationRequested(() => {
      clearTimeout(timer)
      resolve(false)
    })
    timer = setTimeout(() => {
      cancelSub.dispose()
      resolve(true)
    }, INLINE_COMPLETION_PAUSE_MS)
  })
}

/** Whether the editor showing this model moved its cursor off the requested position. */
function cursorMovedAway(
  monaco: MonacoApi,
  model: editor.ITextModel,
  requested: { lineNumber: number; column: number }
): boolean {
  return monaco.editor.getEditors().some((candidate) => {
    const current = candidate.getModel() === model ? candidate.getPosition() : null
    return (
      candidate.hasTextFocus() &&
      current !== null &&
      (current.lineNumber !== requested.lineNumber || current.column !== requested.column)
    )
  })
}

function ensureInlineCompletionProvider(monaco: MonacoApi): void {
  // Re-register when Monaco is recreated; the old provider belongs to the previous instance.
  if (provider && providerMonaco === monaco) {
    return
  }
  provider?.dispose()
  providerMonaco = monaco

  provider = monaco.languages.registerInlineCompletionsProvider('*', {
    async provideInlineCompletions(model, position, _context, token) {
      const info = infoByModel.get(model)
      const run = window.api?.plugins?.editorInlineCompletion
      if (!info || !run || info.isReadOnly() || !pluginEditorHookWanted(INLINE_COMPLETION_HOOK)) {
        return { items: [] }
      }
      if (!(await pausedWithoutCancel(token))) {
        return { items: [] }
      }
      const requestedVersion = model.getVersionId()
      const offset = model.getOffsetAt(position)
      const prefixStart = model.getPositionAt(
        Math.max(0, offset - INLINE_COMPLETION_PREFIX_MAX_CHARS)
      )
      const suffixEnd = model.getPositionAt(offset + INLINE_COMPLETION_SUFFIX_MAX_CHARS)
      const languageId = info.getLanguageId()
      try {
        const { suggestion } = await run({
          workspaceId: info.workspaceId,
          path: info.path,
          ...(languageId ? { languageId } : {}),
          prefix: model.getValueInRange({
            startLineNumber: prefixStart.lineNumber,
            startColumn: prefixStart.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column
          }),
          suffix: model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: suffixEnd.lineNumber,
            endColumn: suffixEnd.column
          })
        })
        // Why: a slow answer for a cursor or text that already moved would flash stale ghost text.
        if (
          !suggestion ||
          token.isCancellationRequested ||
          model.getVersionId() !== requestedVersion ||
          cursorMovedAway(monaco, model, position)
        ) {
          return { items: [] }
        }
        return {
          items: [
            {
              insertText: suggestion,
              range: {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column
              }
            }
          ]
        }
      } catch {
        // Why: a failing plugin must never interrupt typing; its errors land in its own logs.
        return { items: [] }
      }
    },
    disposeInlineCompletions() {}
  })
}

type InlineCompletionEditorRefs = {
  workspaceId: string | undefined
  path: string
  languageRef: { current: string }
  readOnlyRef: { current: boolean }
}

/** Offers ghost text in this editor's model while a plugin lists `editor.inlineCompletion`. */
export function setupInlineCompletion(
  monaco: MonacoApi,
  model: editor.ITextModel | null,
  refs: InlineCompletionEditorRefs
): void {
  if (!model) {
    return
  }
  ensureInlineCompletionProvider(monaco)
  infoByModel.set(model, {
    workspaceId: refs.workspaceId || null,
    path: refs.path,
    getLanguageId: () => refs.languageRef.current,
    isReadOnly: () => refs.readOnlyRef.current
  })
}
