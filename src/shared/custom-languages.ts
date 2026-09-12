import type { languages } from 'monaco-editor'
import type { IRawGrammar } from 'vscode-textmate'

export type CustomLanguage = {
  id: string
  aliases?: string[]
  extensions?: string[]
  filenames?: string[]
  scopeName: string
  configuration?: languages.LanguageConfiguration
}

export type CustomLanguageSnapshot = {
  languages: CustomLanguage[]
  grammars: Record<string, IRawGrammar>
  diagnostics: string[]
}
