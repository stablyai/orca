import type * as Monaco from 'monaco-editor'

// Why: Monaco's stock TS/JS Monarch grammar has a catch-all rule
// `[/[A-Z][\w$]*/, 'type.identifier']` that colors *any* capitalized
// identifier as a type — fine for `class Foo` or `: Foo` type positions, but
// wrong for import bindings: `import { TestWrapper } from '...'` or
// `import React from 'react'` are plain bindings, not type references, and
// real editors (VS Code, via semantic highlighting) render them in the
// default foreground color, not the type color. Themes like Monokai make
// this obvious because their type color (cyan) is visually distinct from
// foreground (off-white) — see heuristic-identifier-token-rules.ts for the
// sibling fix (function calls / ALL_CAPS constants / namespace access).
//
// Fix: intercept the `import` keyword and switch to a dedicated tokenizer
// state that treats every identifier between `import` and `from` as a plain
// 'identifier' — regardless of case — then pops back to the normal common
// state once `from` is seen (or immediately, for side-effect-only imports
// like `import './styles.css'` with no binding at all).
export const IMPORT_CLAUSE_STATE_NAME = 'importClause'

export const IMPORT_KEYWORD_ENTER_RULE: [RegExp, { token: string; next: string }] = [
  // Negative lookahead excludes the dynamic `import(...)` expression, which
  // isn't followed by a binding clause at all.
  /\bimport\b(?!\s*\()/,
  { token: 'keyword', next: `@${IMPORT_CLAUSE_STATE_NAME}` }
]

export const IMPORT_CLAUSE_STATE: Monaco.languages.IMonarchLanguageRule[] = [
  [/[ \t\r\n]+/, ''],
  // Side-effect-only import (`import "./styles.css"`) or the string right
  // after `from` — bail out to the normal tokenizer without consuming, so
  // the shared string rules in 'common' render it exactly as elsewhere.
  [/(?=["'`])/, { token: '', next: '@pop' }],
  [/\bfrom\b/, { token: 'keyword', next: '@pop' }],
  [/\b(as|type)\b/, 'keyword'],
  [/[{}]/, 'delimiter.bracket'],
  [/[,*]/, 'delimiter'],
  [/[a-zA-Z_$][\w$]*/, 'identifier']
]

function withImportClauseIdentifiers(
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
      common: [IMPORT_KEYWORD_ENTER_RULE, ...commonRules],
      [IMPORT_CLAUSE_STATE_NAME]: IMPORT_CLAUSE_STATE
    }
  }
}

export { withImportClauseIdentifiers }
