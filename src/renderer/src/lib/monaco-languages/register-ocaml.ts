import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const OCAML_LANGUAGE_ID = 'ocaml'
export const OCAML_TEXTMATE_SCOPE = 'source.ocaml'
export const OCAML_MLX_LANGUAGE_ID = 'ocaml.mlx'
export const OCAML_MLX_TEXTMATE_SCOPE = 'source.ocaml.mlx'

const OCAML_GRAMMAR_MODULES = new Map<string, () => Promise<{ default: unknown }>>([
  [OCAML_TEXTMATE_SCOPE, () => import('./textmate-grammars/ocaml.tmLanguage.json')],
  ['source.ocaml.interface', () => import('./textmate-grammars/ocaml-interface.tmLanguage.json')],
  [OCAML_MLX_TEXTMATE_SCOPE, () => import('./textmate-grammars/ocaml-mlx.tmLanguage.json')]
])

export const ocamlLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  // Why: OCaml has no line comment, so declaring one would let Cmd+/ insert
  // syntax that does not parse.
  comments: {
    blockComment: ['(*', '*)']
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  // Why: a leading `'` opens a type variable (`'a`) more often than a character
  // literal, so auto-closing it corrupts `let f : 'a -> 'a` as it is typed.
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' }
  ],
  // Why: Monaco's default separates on `'`, which splits primed identifiers
  // (`loop'`) and type variables (`'a`) into two words.
  wordPattern: /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:",.<>/?\s]+)/g
}

// `source.ocaml` and `source.ocaml.interface` include each other, and
// `source.ocaml.mlx` includes the interface grammar too. The registry resolves
// includes through this loader, so all three must be servable.
// `source.ocaml.ocamldoc#markup` is absent: it re-scopes `(** ... *)` bodies
// onto `markup.*`, which stock Monaco themes define no rule for. The registry
// drops an unresolved include, leaving doc comments uniformly
// `comment.doc.ocaml`.
export async function loadOcamlTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  const loadGrammarModule = OCAML_GRAMMAR_MODULES.get(scopeName)
  if (!loadGrammarModule) {
    return null
  }

  // Grammars vendored from ocamllabs/vscode-ocaml-platform (ISC; see
  // textmate-grammars/ocaml-LICENSE.txt).
  const grammarModule = await loadGrammarModule()
  return grammarModule.default as unknown as IRawGrammar
}

export function registerOcamlLanguage(monaco: MonacoModule): void {
  // Why: `source.ocaml#bindings` includes `source.ocaml.interface#bindings`,
  // so this one language id covers `.mli` signature files too.
  registerTextMateLanguage(monaco, {
    language: {
      id: OCAML_LANGUAGE_ID,
      extensions: ['.ml', '.mli'],
      // Why: `extensions` matches suffixes, which would also claim `foo.ocamlinit`.
      filenames: ['.ocamlinit'],
      aliases: ['OCaml', 'ocaml']
    },
    configuration: ocamlLanguageConfiguration,
    scopeName: OCAML_TEXTMATE_SCOPE,
    loadGrammar: loadOcamlTextMateGrammar
  })
}

export function registerOcamlMlxLanguage(monaco: MonacoModule): void {
  // Why: MLX is OCaml with JSX expressions, and its grammar is a superset of the
  // OCaml rules rather than an include of them, so it needs its own scope. The
  // language configuration is shared — upstream points both at the same file.
  registerTextMateLanguage(monaco, {
    language: {
      id: OCAML_MLX_LANGUAGE_ID,
      extensions: ['.mlx'],
      aliases: ['OCaml.mlx', 'ocaml.mlx']
    },
    configuration: ocamlLanguageConfiguration,
    scopeName: OCAML_MLX_TEXTMATE_SCOPE,
    loadGrammar: loadOcamlTextMateGrammar
  })
}
