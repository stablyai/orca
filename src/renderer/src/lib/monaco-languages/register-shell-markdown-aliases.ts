import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco

// Why: Monaco resolves Markdown fences by alias (never extension) and its shell
// language declares `bash` only as an extension, so ```bash rendered plain while
// ```sh highlighted. Re-registering id 'shell' merges the alias and keeps the
// built-in tokenizer; `Shell` stays first because Monaco uses the first alias as
// the language's display name.
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
