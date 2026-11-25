/** What a chat code block's Play runs in a new terminal. */

/** A block's text and the shell that runs it. */
export type CodeBlockScript = { script: string; shell: 'bash' | 'zsh' | 'sh' }

// Only blocks labeled as shell: an unlabeled block may be output or prose.
const SHELL_BY_LANGUAGE: ReadonlyMap<string, CodeBlockScript['shell']> = new Map([
  ['bash', 'bash'],
  ['shell', 'bash'],
  ['zsh', 'zsh'],
  ['sh', 'sh']
])

// C0/C1 controls but tab and newline, bidi and zero-width marks, line separators and blank-rendering fillers.
// oxlint-disable-next-line no-control-regex -- Why: these are exactly the characters a script must not carry.
const HIDDEN_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ]/u
// Spaces other than the ASCII one render as blanks but can hide padding.
const NON_ASCII_SPACE = /[^\P{Zs} ]/u
// A long blank run can push a command past the block's visible edge.
const PADDING_RUN = /[ \t]{40}/

/** The script a shell block runs; null when it has none or carries characters it doesn't show. */
export function codeBlockTerminalScript(
  code: string,
  language: string | undefined
): CodeBlockScript | null {
  const shell = language ? SHELL_BY_LANGUAGE.get(language.toLowerCase()) : undefined
  if (!shell) {
    return null
  }
  const script = code.replace(/\r\n?/g, '\n').trim()
  return script &&
    !HIDDEN_CHARACTERS.test(script) &&
    !NON_ASCII_SPACE.test(script) &&
    !PADDING_RUN.test(script)
    ? { script, shell }
    : null
}
