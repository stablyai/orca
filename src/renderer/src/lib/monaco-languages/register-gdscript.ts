import type * as Monaco from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'
import { registerTextMateLanguage } from './textmate-language-registration'

type MonacoModule = typeof Monaco

export const GDSCRIPT_LANGUAGE_ID = 'gdscript'
export const GDSCRIPT_TEXTMATE_SCOPE = 'source.gdscript'
export const GDRESOURCE_LANGUAGE_ID = 'gdresource'
export const GDRESOURCE_TEXTMATE_SCOPE = 'source.gdresource'

export const gdscriptLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '#'
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

export const gdresourceLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: ';'
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
    { open: '"', close: '"' }
  ]
}

// Why: gdresource embeds source.gdscript, so one loader serves both scopes.
export async function loadGodotTextMateGrammar(scopeName: string): Promise<IRawGrammar | null> {
  if (scopeName === GDSCRIPT_TEXTMATE_SCOPE) {
    const grammarModule = await import('./textmate-grammars/gdscript.tmLanguage.json')
    return grammarModule.default as unknown as IRawGrammar
  }
  if (scopeName === GDRESOURCE_TEXTMATE_SCOPE) {
    const grammarModule = await import('./textmate-grammars/gdresource.tmLanguage.json')
    return grammarModule.default as unknown as IRawGrammar
  }
  return null
}

export function registerGdscriptLanguage(monaco: MonacoModule): void {
  registerTextMateLanguage(monaco, {
    language: {
      id: GDSCRIPT_LANGUAGE_ID,
      extensions: ['.gd'],
      aliases: ['GDScript', 'gdscript']
    },
    configuration: gdscriptLanguageConfiguration,
    scopeName: GDSCRIPT_TEXTMATE_SCOPE,
    loadGrammar: loadGodotTextMateGrammar
  })
  registerTextMateLanguage(monaco, {
    language: {
      id: GDRESOURCE_LANGUAGE_ID,
      extensions: ['.tscn', '.tres', '.escn', '.godot'],
      aliases: ['Godot Resource', 'gdresource']
    },
    configuration: gdresourceLanguageConfiguration,
    scopeName: GDRESOURCE_TEXTMATE_SCOPE,
    loadGrammar: loadGodotTextMateGrammar
  })
}
