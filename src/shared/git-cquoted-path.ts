export function decodeGitCQuotedPath(value: string): string {
  if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"') {
    return value
  }

  let decoded = ''
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index]
    if (char !== '\\') {
      decoded += char
      continue
    }

    index += 1
    const escaped = value[index]
    switch (escaped) {
      case 'a':
        decoded += '\u0007'
        break
      case 'b':
        decoded += '\b'
        break
      case 'f':
        decoded += '\f'
        break
      case 'n':
        decoded += '\n'
        break
      case 'r':
        decoded += '\r'
        break
      case 't':
        decoded += '\t'
        break
      case 'v':
        decoded += '\v'
        break
      case '\\':
      case '"':
        decoded += escaped
        break
      default:
        if (/[0-7]/.test(escaped)) {
          const bytes: number[] = []
          let octalStart = index
          while (octalStart < value.length - 1) {
            let octal = value[octalStart]
            let octalEnd = octalStart
            while (
              octalEnd + 1 < value.length - 1 &&
              octal.length < 3 &&
              /[0-7]/.test(value[octalEnd + 1])
            ) {
              octalEnd += 1
              octal += value[octalEnd]
            }
            bytes.push(Number.parseInt(octal, 8))
            index = octalEnd
            if (value[index + 1] !== '\\' || !/[0-7]/.test(value[index + 2] ?? '')) {
              break
            }
            octalStart = index + 2
          }
          // Why: Git C-quotes non-ASCII text as adjacent UTF-8 octal bytes;
          // decoding each byte as a character corrupts localized lock reasons.
          decoded += new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(bytes))
        } else {
          decoded += escaped
        }
        break
    }
  }

  return decoded
}
