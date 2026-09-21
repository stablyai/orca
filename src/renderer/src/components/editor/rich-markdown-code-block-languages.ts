import { i18n, translate } from '@/i18n/i18n'

export type CodeBlockLanguage = { value: string; label: string }

/**
 * Common languages shown in the selector. The user can also type a language
 * name directly in the markdown fence (```rust) and it will be preserved —
 * this list is just for quick picking in the UI.
 *
 * A null key means the label is identical in every locale.
 */
type LanguageEntry = readonly [value: string, key: string | null, label: string]

const LANGUAGE_ENTRIES: readonly LanguageEntry[] = [
  ['', 'auto.components.editor.RichMarkdownCodeBlock.13822cdfda', 'Plain text'],
  ['bash', 'auto.components.editor.RichMarkdownCodeBlock.4227cf50fe', 'Bash'],
  ['c', null, 'C'],
  ['cpp', 'auto.components.editor.RichMarkdownCodeBlock.4daed43ae3', 'C++'],
  ['css', 'auto.components.editor.RichMarkdownCodeBlock.026653f21f', 'CSS'],
  ['diff', 'auto.components.editor.RichMarkdownCodeBlock.bf6ee5caaa', 'Diff'],
  ['go', 'auto.components.editor.RichMarkdownCodeBlock.edfcc64182', 'Go'],
  ['graphql', 'auto.components.editor.RichMarkdownCodeBlock.706fd85738', 'GraphQL'],
  ['html', 'auto.components.editor.RichMarkdownCodeBlock.8c4a3fa02d', 'HTML'],
  ['java', 'auto.components.editor.RichMarkdownCodeBlock.36536ad539', 'Java'],
  ['javascript', 'auto.components.editor.RichMarkdownCodeBlock.a209c57063', 'JavaScript'],
  ['json', 'auto.components.editor.RichMarkdownCodeBlock.78eba32de4', 'JSON'],
  ['kotlin', 'auto.components.editor.RichMarkdownCodeBlock.bcb236e2d8', 'Kotlin'],
  ['markdown', 'auto.components.editor.RichMarkdownCodeBlock.983b9576b4', 'Markdown'],
  ['mermaid', 'auto.components.editor.RichMarkdownCodeBlock.89d6cc14fb', 'Mermaid'],
  ['python', 'auto.components.editor.RichMarkdownCodeBlock.2391f9cda9', 'Python'],
  ['ruby', 'auto.components.editor.RichMarkdownCodeBlock.96182a2f64', 'Ruby'],
  ['rust', 'auto.components.editor.RichMarkdownCodeBlock.e72e6b03f4', 'Rust'],
  ['scss', 'auto.components.editor.RichMarkdownCodeBlock.5af8251002', 'SCSS'],
  ['shell', 'auto.components.editor.RichMarkdownCodeBlock.d01f55be57', 'Shell'],
  ['sql', 'auto.components.editor.RichMarkdownCodeBlock.3009f722b9', 'SQL'],
  ['swift', 'auto.components.editor.RichMarkdownCodeBlock.9e384d48dc', 'Swift'],
  ['typescript', 'auto.components.editor.RichMarkdownCodeBlock.88d777bc07', 'TypeScript'],
  ['xml', 'auto.components.editor.RichMarkdownCodeBlock.5ef5605cb7', 'XML'],
  ['yaml', 'auto.components.editor.RichMarkdownCodeBlock.74eab1d9b2', 'YAML']
]

let cachedLocale: string | null = null
let cachedResourceBundle: unknown = null
let cachedLanguages: CodeBlockLanguage[] = []

/** Why: labels were getters that re-translated on every property read, so one
 *  render of a code-block-heavy document cost thousands of i18next lookups. */
export function getCodeBlockLanguages(): CodeBlockLanguage[] {
  const resourceBundle = i18n.getResourceBundle(i18n.language, 'translation')
  if (cachedLocale !== i18n.language || cachedResourceBundle !== resourceBundle) {
    cachedLocale = i18n.language
    cachedResourceBundle = resourceBundle
    cachedLanguages = LANGUAGE_ENTRIES.map(([value, key, label]) => ({
      value,
      label: key === null ? label : translate(key, label)
    }))
  }
  return cachedLanguages
}

export function getCodeBlockLanguageLabel(value: string): string {
  return getCodeBlockLanguages().find((language) => language.value === value)?.label ?? value
}

export function isKnownCodeBlockLanguage(value: string): boolean {
  return getCodeBlockLanguages().some((language) => language.value === value)
}
