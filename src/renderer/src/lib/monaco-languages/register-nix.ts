import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const NIX_LANGUAGE_ID = 'nix'
export const NIX_TEXTMATE_SCOPE = 'source.nix'

// Why: Nix identifiers and attribute names routinely contain hyphens and
// slashes (home-manager, nixos/modules); Monaco's default word pattern splits
// on '-', breaking double-click selection and word-based occurrence matching.
// Pattern from nix-community/vscode-nix-ide language-configuration.json.
const NIX_WORD_PATTERN =
  /(-?\d*\.\d\w*)|((~|[^`~!@#%^&*()=+[{\]}\\|;:'",<>/?\s]+)\/[^`~!@#%^&*()=+[{\]}\\|;:'",<>?\s]+)|([^`~!@#%^&*()=+[{\]}\\|;:'",.<>/?\s]+)/g

// Why: the configuration is a factory because onEnterRules needs the runtime
// monaco.languages.IndentAction enum, which type-only imports cannot provide.
export function createNixLanguageConfiguration(
  monaco: MonacoModule
): Monaco.languages.LanguageConfiguration {
  const { IndentAction } = monaco.languages
  return {
    comments: {
      lineComment: '#',
      blockComment: ['/*', '*/']
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')']
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
      // Why: '' is Nix's indented-string delimiter, a distinct two-character
      // quote pair — not two auto-closed single quotes.
      { open: "''", close: "''", notIn: ['string', 'comment'] }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "''", close: "''" }
    ],
    wordPattern: NIX_WORD_PATTERN,
    // Why: indentation rules from nix-community/vscode-nix-ide, so Enter
    // between paired keywords (let/in, if/then, then/else) and inside ''
    // indented strings indents like nixfmt expects.
    onEnterRules: [
      {
        beforeText: /^.*\blet\s*$/,
        afterText: /\s*in\b.*$/,
        action: { indentAction: IndentAction.IndentOutdent }
      },
      {
        beforeText: /^.*\bif\s*$/,
        afterText: /\s*then\b.*$/,
        action: { indentAction: IndentAction.IndentOutdent }
      },
      {
        beforeText: /^.*\bthen\s*$/,
        afterText: /\s*else\b.*$/,
        action: { indentAction: IndentAction.IndentOutdent }
      },
      {
        beforeText: /^.*''\s*$/,
        afterText: /\s*''.*$/,
        action: { indentAction: IndentAction.IndentOutdent }
      },
      {
        beforeText: /^.*\/\*\*\s*$/,
        afterText: /\s*\*\/.*$/,
        action: { indentAction: IndentAction.IndentOutdent }
      },
      {
        beforeText: /^.*(?:=|\/\*\*|'')\s*$/,
        action: { indentAction: IndentAction.Indent }
      },
      {
        // Why: `in` is intentionally absent — nixfmt does not indent after it.
        beforeText: /^.*\b(?:let|with|if|then|else|rec|or|and|assert|inherit)\s*$/,
        action: { indentAction: IndentAction.Indent }
      }
    ]
  }
}

export async function loadNixTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName !== NIX_TEXTMATE_SCOPE) {
    return null
  }

  // Why: Nix highlighting uses the maintained VS Code TextMate grammar from
  // nix-community/vscode-nix-ide (MIT; see textmate-grammars/nix-LICENSE.txt).
  const grammarModule = await import('./textmate-grammars/nix.tmLanguage.json')
  return grammarModule.default as unknown as IRawGrammar
}

export function registerNixLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: NIX_LANGUAGE_ID,
      extensions: ['.nix'],
      aliases: ['Nix', 'nix']
    },
    configuration: createNixLanguageConfiguration(monaco),
    scopeName: NIX_TEXTMATE_SCOPE,
    loadGrammar: loadNixTextMateGrammar
  })
}
