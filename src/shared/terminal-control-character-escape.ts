export function escapeTerminalControlCharacters(value: string, escapeLineBreaks = false): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      if (
        (!escapeLineBreaks && character === '\n') ||
        (code >= 0x20 && code < 0x7f) ||
        code > 0x9f
      ) {
        return character
      }
      return `\\x${code.toString(16).padStart(2, '0')}`
    })
    .join('')
}
