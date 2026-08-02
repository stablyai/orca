// Why: command strings may include pasted scripts; first-token classification must stay bounded.
export const COMMAND_TOKEN_SCAN_MAX_CHARS = 4096

export function getFirstCommandToken(command: string): string {
  const scanLimit = Math.min(command.length, COMMAND_TOKEN_SCAN_MAX_CHARS)
  let index = 0

  while (index < scanLimit && isCommandTokenWhitespace(command.charCodeAt(index))) {
    index += 1
  }
  if (index >= scanLimit) {
    return ''
  }

  const quote = command[index]
  if ((quote === '"' || quote === "'") && index + 1 < scanLimit) {
    const tokenStart = index + 1
    for (let end = tokenStart; end < scanLimit; end += 1) {
      if (command[end] === quote) {
        if (end > tokenStart) {
          return command.slice(tokenStart, end)
        }
        break
      }
    }
  }

  const tokenStart = index
  while (index < scanLimit && !isCommandTokenWhitespace(command.charCodeAt(index))) {
    index += 1
  }
  return command.slice(tokenStart, index)
}

export function getCommandTokenPathBasename(token: string): string {
  for (let index = token.length - 1; index >= 0; index -= 1) {
    const code = token.charCodeAt(index)
    if (code === 47 || code === 92) {
      return token.slice(index + 1)
    }
  }
  return token
}

export function commandContainsToken(command: string, expectedToken: string): boolean {
  if (!expectedToken) {
    return false
  }

  const scanLimit = Math.min(command.length, COMMAND_TOKEN_SCAN_MAX_CHARS)
  let index = 0

  while (index < scanLimit) {
    while (index < scanLimit && isCommandTokenWhitespace(command.charCodeAt(index))) {
      index += 1
    }
    const tokenStart = index
    while (index < scanLimit && !isCommandTokenWhitespace(command.charCodeAt(index))) {
      index += 1
    }
    if (tokenStart < index && command.slice(tokenStart, index) === expectedToken) {
      return true
    }
  }

  return false
}

function isCommandTokenWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}
