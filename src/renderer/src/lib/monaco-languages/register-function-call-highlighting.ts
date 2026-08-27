import type * as Monaco from 'monaco-editor'
import { language as typescriptMonarchLanguage } from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js'
import { language as javascriptMonarchLanguage } from 'monaco-editor/esm/vs/basic-languages/javascript/javascript.js'
import { HEURISTIC_IDENTIFIER_TOKEN_RULES } from './heuristic-identifier-token-rules'
import {
  IMPORT_CLAUSE_STATE,
  IMPORT_CLAUSE_STATE_NAME,
  IMPORT_KEYWORD_ENTER_RULE
} from './import-clause-token-rules'

// Why: Monaco's bundled TS/JS Monarch grammar (basic-languages/typescript) is
// purely syntactic — it has no notion of "this identifier is being called as
// a function", so `loadData(` and a plain variable `loadData` both come out
// as the generic 'identifier' token. Real editors (VS Code) only get the
// green-for-functions/methods look from *semantic* highlighting, which isn't
// wired up for Monaco's standalone TS worker here (see monaco-setup.ts's
// diagnosticsOptions comment — the worker is intentionally kept lightweight).
// Rather than stand up a semantic tokens provider, patch the syntactic
// tokenizer with a few extra rules ahead of the generic identifier rule — see
// heuristic-identifier-token-rules.ts for what each one does and why the
// order matters. Same trick used by register-theme-preview-language.ts for
// the Settings preview, applied here to the real file/diff editors so their
// coloring actually matches what a theme like Monokai/Dracula intends.
//
// Also patches import clauses specifically: the stock grammar's catch-all
// `[/[A-Z][\w$]*/, 'type.identifier']` rule wrongly colors capitalized import
// bindings (`import React from 'react'`, `import { TestWrapper } from ...`)
// as types — they're plain bindings, not type references. See
// import-clause-token-rules.ts.

function withHeuristicIdentifierTokens(
  language: Monaco.languages.IMonarchLanguage
): Monaco.languages.IMonarchLanguage {
  const commonRules = language.tokenizer.common
  if (!commonRules) {
    return language
  }
  return {
    ...language,
    tokenizer: {
      ...language.tokenizer,
      common: [...HEURISTIC_IDENTIFIER_TOKEN_RULES, IMPORT_KEYWORD_ENTER_RULE, ...commonRules],
      [IMPORT_CLAUSE_STATE_NAME]: IMPORT_CLAUSE_STATE
    }
  }
}

let registered = false

/** Idempotent: safe to call on every editor mount, only overrides the
 *  tokenizer once per process. Must run after Monaco's own 'typescript'/
 *  'javascript' languages are registered (they lazy-load on first use, so
 *  this either overrides an already-loaded tokenizer or wins the race by
 *  registering before the lazy loader's `create()` resolves — Monaco takes
 *  the last `setMonarchTokensProvider` call for a given language id). */
export function registerFunctionCallHighlighting(monacoInstance: typeof Monaco): void {
  if (registered) {
    return
  }
  monacoInstance.languages.setMonarchTokensProvider(
    'typescript',
    withHeuristicIdentifierTokens(typescriptMonarchLanguage)
  )
  monacoInstance.languages.setMonarchTokensProvider(
    'javascript',
    withHeuristicIdentifierTokens(javascriptMonarchLanguage)
  )
  registered = true
}
