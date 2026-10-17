import type * as MonacoNamespace from 'monaco-editor'
import type { IDisposable } from 'monaco-editor'
import { toLspPosition } from './lsp-monaco-position-conversion'
import { copilotInlineCompletionsToMonaco } from './copilot-inline-completion-conversion'
import {
  flushPendingCopilotChange,
  getCopilotEntryForModelUri,
  isWithinCopilotSizeLimit,
  reopenCopilotDocument
} from './monaco-copilot-documents'

let registration: IDisposable | null = null

/** Registers one ghost-text provider for every language; it answers only for
 *  models attached to Copilot. Tab accept is Monaco-native. */
export function ensureCopilotInlineProvider(monaco: typeof MonacoNamespace): void {
  if (registration) {
    return
  }
  registration = monaco.languages.registerInlineCompletionsProvider('*', {
    displayName: 'GitHub Copilot',
    provideInlineCompletions: async (model, position, context, token) => {
      const entry = getCopilotEntryForModelUri(model.uri.toString())
      if (!entry || !isWithinCopilotSizeLimit(model)) {
        return { items: [] }
      }
      try {
        await flushPendingCopilotChange(entry)
        if (token.isCancellationRequested) {
          return { items: [] }
        }
        const options = model.getOptions()
        const response = await window.api.copilotCompletion.inlineCompletion({
          fileUri: entry.fileUri,
          position: toLspPosition(position),
          trigger:
            context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit
              ? 'explicit'
              : 'automatic',
          formattingOptions: { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
        })
        if (!response.opened) {
          void reopenCopilotDocument(entry)
          return { items: [] }
        }
        if (token.isCancellationRequested || model.isDisposed()) {
          return { items: [] }
        }
        return { items: copilotInlineCompletionsToMonaco(response.result, model.getEOL()) }
      } catch {
        return { items: [] }
      }
    },
    disposeInlineCompletions: () => {}
  })
}
