import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco
type ShellLanguageRegistry = Pick<MonacoModule['languages'], 'getLanguages' | 'register'>

export const SHELL_LANGUAGE_ID = 'shell'
export const BASH_MARKDOWN_LANGUAGE_ALIAS = 'bash'

export function registerShellMarkdownAliases(monaco: { languages: ShellLanguageRegistry }): void {
  const bashAliasAlreadyRegistered = monaco.languages
    .getLanguages()
    .some(
      (language) =>
        language.id === SHELL_LANGUAGE_ID &&
        language.aliases?.some((alias) => alias.toLowerCase() === BASH_MARKDOWN_LANGUAGE_ALIAS)
    )
  if (bashAliasAlreadyRegistered) {
    return
  }

  // Monaco merges repeated IDs, preserving its lazy tokenizer while adding fence lookup.
  monaco.languages.register({
    id: SHELL_LANGUAGE_ID,
    aliases: ['Shell', 'sh', BASH_MARKDOWN_LANGUAGE_ALIAS]
  })
}
