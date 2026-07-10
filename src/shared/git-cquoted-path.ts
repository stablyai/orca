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
          let octal = escaped
          while (
            index + 1 < value.length - 1 &&
            octal.length < 3 &&
            /[0-7]/.test(value[index + 1])
          ) {
            index += 1
            octal += value[index]
          }
          decoded += String.fromCharCode(Number.parseInt(octal, 8))
        } else {
          decoded += escaped
        }
        break
    }
  }

  return decoded
}
