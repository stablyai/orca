/** What a chat code block's Play runs in a new terminal; mobile and desktop share it. */

// Only blocks labeled as shell: an unlabeled block may be output or prose, and fish lacks `$?`.
const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh'])

// C0/C1 controls but tab and newline, plus bidi and zero-width marks: what runs could differ from what shows.
// oxlint-disable-next-line no-control-regex -- Why: these are exactly the characters a script must not carry.
const HIDDEN_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}]/u

/** The script a shell block runs in a new terminal, one command per line; null when it has none
 *  or carries characters it doesn't show. */
export function codeBlockTerminalScript(code: string, language: string | undefined): string | null {
  if (!language || !SHELL_LANGUAGES.has(language.toLowerCase())) {
    return null
  }
  const script = code.replace(/\r\n?/g, '\n').trim()
  // Tabs become spaces so a pasted tab can't trigger completion.
  return script && !HIDDEN_CHARACTERS.test(script) ? script.replaceAll('\t', ' ') : null
}
