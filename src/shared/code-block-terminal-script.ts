/** What a chat code block's Play runs in a new terminal. */

// Only blocks labeled as shell: an unlabeled block may be output or prose, and fish lacks `$?`.
const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh'])

// C0/C1 controls but tab and newline, bidi and zero-width marks, line separators and blank-rendering fillers.
// oxlint-disable-next-line no-control-regex -- Why: these are exactly the characters a script must not carry.
const HIDDEN_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0]/u
// Spaces other than the ASCII one render as blanks but can hide padding.
const NON_ASCII_SPACE = /[^\P{Zs} ]/u
// A long blank run can push a command past the block's visible edge.
const PADDING_RUN = /[ \t]{40}/

/** The script a shell block runs in a new terminal, one command per line; null when it has none
 *  or carries characters it doesn't show. */
export function codeBlockTerminalScript(code: string, language: string | undefined): string | null {
  if (!language || !SHELL_LANGUAGES.has(language.toLowerCase())) {
    return null
  }
  const script = code.replace(/\r\n?/g, '\n').trim()
  // Tabs become spaces so a pasted tab can't trigger completion.
  return script &&
    !HIDDEN_CHARACTERS.test(script) &&
    !NON_ASCII_SPACE.test(script) &&
    !PADDING_RUN.test(script)
    ? script.replaceAll('\t', ' ')
    : null
}
