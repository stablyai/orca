import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

// Markdown resolves fence aliases, not extensions: merge bash into shell without replacing its tokenizer; retain Shell first as the display name.
export function registerShellMarkdownAliases(monaco: {
  languages: Pick<MonacoModule['languages'], 'getLanguages' | 'register'>
}): void {
  const bashAlreadyRegistered = monaco.languages
    .getLanguages()
    .some(
      ({ id, aliases }) =>
        id === 'shell' && aliases?.some((alias) => alias.toLowerCase() === 'bash')
    )
  if (bashAlreadyRegistered) {
    return
  }

  monaco.languages.register({ id: 'shell', aliases: ['Shell', 'sh', 'bash'] })
}
