import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const GDSCRIPT_LANGUAGE_ID = 'gdscript'
export const GDSCRIPT_TEXTMATE_SCOPE = 'source.gdscript'

export const gdscriptLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
}

export async function loadGDScriptTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName !== GDSCRIPT_TEXTMATE_SCOPE) {
    return null
  }

  // Why: match Godot's maintained VS Code GDScript highlighting (MIT; see license).
  const grammarModule = await import('./textmate-grammars/gdscript.tmLanguage.json')
  return grammarModule.default as unknown as IRawGrammar
}

export function registerGDScriptLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: GDSCRIPT_LANGUAGE_ID,
      extensions: ['.gd'],
      aliases: ['GDScript', 'gdscript']
    },
    configuration: gdscriptLanguageConfiguration,
    scopeName: GDSCRIPT_TEXTMATE_SCOPE,
    loadGrammar: loadGDScriptTextMateGrammar
  })
}
