import type * as Monaco from 'monaco-editor'
import type { PluginSyntaxPayload } from '../../../../shared/plugins/artifacts/plugin-syntax-artifact'
import {
  PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT,
  PLUGIN_GRAMMAR_MODEL_LINE_LIMIT
} from './plugin-grammar-protocol'
import {
  PluginGrammarWorkerClient,
  type PluginGrammarFailure,
  type PluginGrammarWorker
} from './plugin-grammar-worker-client'
import { PLUGIN_SYNTAX_TOKEN_TYPES, encodePluginSyntaxTokens } from './plugin-syntax-token-legend'

export type PluginSyntaxEngine = {
  /** Moves models still in this slot's language back to plain text, so a later reuse of the
   *  slot by another plugin language never paints them with the wrong grammar. */
  releaseModels: () => void
  dispose: () => void
}

/**
 * Highlights one slot's language through Monaco semantic tokens. Monaco asks only for models shown
 * in an editor, keeps one request per model (newest text wins), and keeps painting the previous
 * tokens, shifted by edits, until the new pass lands.
 */
export function createPluginSyntaxEngine(options: {
  monaco: Pick<typeof Monaco, 'languages' | 'editor'>
  languageId: string
  load: () => Promise<PluginSyntaxPayload | null>
  createWorker: () => PluginGrammarWorker
  onFailure: (reason: PluginGrammarFailure) => void
}): PluginSyntaxEngine {
  const { monaco, languageId } = options
  const disposables: Monaco.IDisposable[] = []
  let failed = false
  let client: Promise<PluginGrammarWorkerClient | null> | null = null

  const fail = (reason: PluginGrammarFailure): void => {
    // Why latch: a grammar that stalled or crashed would burn a worker on every edit.
    if (!failed && (reason === 'stalled' || reason === 'crashed' || reason === 'unavailable')) {
      failed = true
      options.onFailure(reason)
    }
  }

  const loadClient = (): Promise<PluginGrammarWorkerClient | null> => {
    client ??= options
      .load()
      .then((payload) => {
        if (!payload) {
          return null
        }
        disposables.push(
          monaco.languages.setLanguageConfiguration(languageId, payload.configuration)
        )
        return new PluginGrammarWorkerClient(
          payload.scopeName,
          payload.grammars,
          options.createWorker
        )
      })
      .catch(() => null)
    return client
  }

  disposables.push(
    monaco.languages.registerDocumentSemanticTokensProvider(languageId, {
      getLegend: () => ({ tokenTypes: [...PLUGIN_SYNTAX_TOKEN_TYPES], tokenModifiers: [] }),
      releaseDocumentSemanticTokens: () => {},
      provideDocumentSemanticTokens: async (model, _lastResultId, token) => {
        // Why length first: reading a huge model's text just to reject it is the cost to avoid.
        if (
          failed ||
          model.getValueLength() > PLUGIN_GRAMMAR_MODEL_CHARACTER_LIMIT ||
          model.getLineCount() > PLUGIN_GRAMMAR_MODEL_LINE_LIMIT
        ) {
          return null
        }
        const grammarClient = await loadClient()
        if (!grammarClient) {
          fail('unavailable')
          return null
        }
        const controller = new AbortController()
        const cancel = token.onCancellationRequested(() => controller.abort())
        try {
          const lineLengths = Array.from({ length: model.getLineCount() }, (_, index) =>
            model.getLineLength(index + 1)
          )
          const outcome = await grammarClient.tokenize(
            model.getValue(),
            lineLengths,
            controller.signal
          )
          if (!outcome.ok) {
            if (outcome.reason !== 'aborted') {
              fail(outcome.reason)
            }
            return null
          }
          return { data: encodePluginSyntaxTokens(outcome.tokens.data) }
        } finally {
          cancel.dispose()
        }
      }
    })
  )

  return {
    releaseModels: () => {
      for (const model of monaco.editor.getModels()) {
        if (!model.isDisposed() && model.getLanguageId() === languageId) {
          monaco.editor.setModelLanguage(model, 'plaintext')
        }
      }
    },
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose()
      }
      void client?.then((grammarClient) => grammarClient?.dispose())
    }
  }
}
