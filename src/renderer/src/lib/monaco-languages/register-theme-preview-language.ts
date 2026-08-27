import type * as Monaco from 'monaco-editor'
import { HEURISTIC_IDENTIFIER_TOKEN_RULES } from './heuristic-identifier-token-rules'
import {
  IMPORT_CLAUSE_STATE,
  IMPORT_CLAUSE_STATE_NAME,
  IMPORT_KEYWORD_ENTER_RULE
} from './import-clause-token-rules'

export const THEME_PREVIEW_LANGUAGE_ID = 'orca-theme-preview'

// Why a dedicated Monarch tokenizer instead of Monaco's bundled 'typescript':
// Monaco's built-in TS/JS Monarch grammar is purely syntactic — it has no
// notion of "this identifier is being called as a function", so `loadData(`
// and a plain variable both come out as the generic 'identifier' token. Real
// editors (VS Code) only get the green-for-functions look from *semantic*
// highlighting, which isn't wired up for Monaco's standalone TS worker here.
// For a theme preview, the distinction matters more than full TS fidelity, so
// this tokenizer borrows the same heuristic rules used to patch the real
// file/diff editors (register-function-call-highlighting.ts) — see
// heuristic-identifier-token-rules.ts for what each one does.
const KEYWORDS = new Set([
  'import',
  'from',
  'export',
  'default',
  'async',
  'await',
  'function',
  'return',
  'const',
  'let',
  'var',
  'interface',
  'type',
  'class',
  'extends',
  'implements',
  'new',
  'this',
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'true',
  'false',
  'null',
  'undefined',
  'void',
  'in',
  'of',
  'typeof',
  'instanceof',
  'as'
])

export const themePreviewLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ]
}

export const themePreviewMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.orca-theme-preview',
  keywords: [...KEYWORDS],
  tokenizer: {
    root: [
      [/\/\/.*$/, 'comment'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'([^'\\]|\\.)*'/, 'string'],
      [/`([^`\\]|\\.)*`/, 'string'],
      IMPORT_KEYWORD_ENTER_RULE,
      // Identifier-role heuristics (function calls, ALL_CAPS constants,
      // namespace/enum access) — must come before the generic
      // type.identifier/identifier rules below. See heuristic-identifier-token-rules.ts.
      ...HEURISTIC_IDENTIFIER_TOKEN_RULES,
      [/[A-Z][\w$]*/, 'type.identifier'],
      [
        /[a-zA-Z_$][\w$]*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@default': 'identifier'
          }
        }
      ],
      [/\d+/, 'number'],
      [/[{}()[\]]/, '@brackets'],
      [/[;,.:]/, 'delimiter']
    ],
    [IMPORT_CLAUSE_STATE_NAME]: IMPORT_CLAUSE_STATE
  }
}

let registered = false

/** Idempotent: safe to call on every preview mount, only registers the
 *  language + tokenizer once per process. */
export function registerThemePreviewLanguage(monacoInstance: typeof Monaco): void {
  if (registered) {
    return
  }
  monacoInstance.languages.register({ id: THEME_PREVIEW_LANGUAGE_ID })
  monacoInstance.languages.setLanguageConfiguration(
    THEME_PREVIEW_LANGUAGE_ID,
    themePreviewLanguageConfiguration
  )
  monacoInstance.languages.setMonarchTokensProvider(
    THEME_PREVIEW_LANGUAGE_ID,
    themePreviewMonarchLanguage
  )
  registered = true
}
