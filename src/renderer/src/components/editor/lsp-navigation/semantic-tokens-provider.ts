// Semantic-token coloring provider (S5 / spike findings §1). Registers a
// monaco DocumentSemanticTokensProvider that fetches decoded tokens over IPC
// (the main process decoded the server legend BY NAME) and re-encodes them
// against the renderer legend into Monaco's relative 5-tuple Uint32Array.
// Also defines the 'orca-lsp-dark' theme on VS Code Dark+ approximations.
//
// THREE GATES the spike empirically located (all required, all here):
//   1. config: the FLAT `'semanticHighlighting.enabled': true` editor option
//      (set at the editor creation site, NOT here — nested shape does not work).
//   2. attach: monaco never fetches tokens for a model not attached to an
//      editor; the onMount re-setModel fix lives at the editor mount site.
//   3. shape: getLegend() MUST be a METHOD (not a `legend` property) — getting
//      this wrong makes fetch happen but the consumer throws
//      `getLegend is not a function` (swallowed by pageerror) -> no color.
import type * as Monaco from 'monaco-editor'
import { nativePathForModel } from './editor-model-language-server-owner'
import {
  reencodeSemanticTokensForMonaco,
  SEMANTIC_TOKEN_RENDERER_MODIFIERS,
  SEMANTIC_TOKEN_RENDERER_TYPES
} from './semantic-tokens-reencode'

const SELECTOR = ['cpp', 'c']

// VS Code Dark+ approximations for identifier-class tokens (spike findings §1).
// Covers EVERY type in the client legend (SEMANTIC_TOKEN_RENDERER_TYPES) so a
// token whose type matches the legend is never left NO_STYLING (grey) — the
// spike only colored the original 5, leaving property/method/parameter/
// namespace unstyled, which showed up as the `.`-access members all grey.
// keyword/string/number/comment/operator are also defined with vs-dark values
// so the Monarch lexical layer stacks without conflict (clangd self-invented
// enum/comment/operator/typeParameter/unknown/bracket types route through
// NO_STYLING to the lexical layer, whose rules these pin).
const ORCA_LSP_DARK_RULES = [
  { token: 'function', foreground: 'dcdcaa' },
  { token: 'method', foreground: 'dcdcaa' },
  { token: 'type', foreground: '4ec9b0' },
  { token: 'class', foreground: '4ec9b0' },
  { token: 'enum', foreground: '4ec9b0' },
  { token: 'namespace', foreground: '4ec9b0' },
  { token: 'typeParameter', foreground: '4ec9b0' },
  { token: 'variable', foreground: '9cdcfe' },
  { token: 'property', foreground: '9cdcfe' },
  { token: 'parameter', foreground: '9cdcfe' },
  { token: 'macro', foreground: 'c586c0' },
  { token: 'enumMember', foreground: '4fc1ff' },
  // Lexical layer (clangd legend has no keyword/string/number) — keep vs-dark values.
  { token: 'keyword', foreground: '569cd6' },
  { token: 'string', foreground: 'ce9178' },
  { token: 'number', foreground: 'b5cea8' },
  { token: 'comment', foreground: '608b4e' },
  { token: 'operator', foreground: 'd4d4d4' }
]

/**
 * Defines the orca-lsp-dark theme + registers the semantic-tokens provider.
 * Idempotent at the call site (monaco-setup runs once); returns a disposable.
 */
export function installLanguageServerSemanticTokensProvider(monaco: typeof Monaco): () => void {
  monaco.editor.defineTheme('orca-lsp-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: ORCA_LSP_DARK_RULES,
    colors: {}
  })

  const provider = {
    // GATE 3: a METHOD, not a property. Wrong shape => silent no-color
    // (spike findings §1).
    getLegend(): Monaco.languages.SemanticTokensLegend {
      return {
        tokenTypes: [...SEMANTIC_TOKEN_RENDERER_TYPES],
        tokenModifiers: [...SEMANTIC_TOKEN_RENDERER_MODIFIERS]
      }
    },
    async provideDocumentSemanticTokens(
      model: Monaco.editor.ITextModel
    ): Promise<Monaco.languages.SemanticTokens | null> {
      const filePath = nativePathForModel(model)
      if (!filePath) {
        return null
      }
      const result = await window.api.languageServers.semanticTokens({ filePath })
      if (!result.ok || !result.tokens) {
        // IPC failure / no session -> empty set degrades to lexical (Monarch) color.
        return { data: new Uint32Array(0) }
      }
      return { data: reencodeSemanticTokensForMonaco(result.tokens.tokens) }
    },
    releaseDocumentSemanticTokens(): void {
      // clangd full-only: no incremental result state to release (spike §1).
    }
  }

  const registration = monaco.languages.registerDocumentSemanticTokensProvider(SELECTOR, provider)

  return () => {
    registration.dispose()
  }
}
