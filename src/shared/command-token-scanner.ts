// Why: command strings may include pasted scripts; first-token classification must stay bounded.
export const COMMAND_TOKEN_SCAN_MAX_CHARS = 4096

/**
 * PowerShell's call operator. `buildShellCommandFromArgv` prefixes every
 * PowerShell launch line with it so a quoted executable path is executed rather
 * than echoed, so it is syntax and never the executable — first-token
 * classification has to look past it. Only a standalone `&` followed by
 * whitespace counts, which leaves `&&`, `&foo` and a posix line's inner `&`
 * alone.
 */
export const POWERSHELL_CALL_OPERATOR = '&'

function skipCommandTokenWhitespace(command: string, from: number, scanLimit: number): number {
  let index = from
  while (index < scanLimit && isCommandTokenWhitespace(command.charCodeAt(index))) {
    index += 1
  }
  return index
}

export function getFirstCommandToken(command: string): string {
  const scanLimit = Math.min(command.length, COMMAND_TOKEN_SCAN_MAX_CHARS)
  let index = skipCommandTokenWhitespace(command, 0, scanLimit)
  if (index >= scanLimit) {
    return ''
  }
  if (
    command[index] === POWERSHELL_CALL_OPERATOR &&
    index + 1 < scanLimit &&
    isCommandTokenWhitespace(command.charCodeAt(index + 1))
  ) {
    index = skipCommandTokenWhitespace(command, index + 1, scanLimit)
    if (index >= scanLimit) {
      return ''
    }
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
