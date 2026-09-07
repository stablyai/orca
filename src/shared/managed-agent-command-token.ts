const QUOTES = new Set(['"', "'"])

type ExtractExecutableTokenOptions = {
  platform?: NodeJS.Platform
}

export function extractExecutableToken(
  command: string | null | undefined,
  options: ExtractExecutableTokenOptions = {}
): string | null {
  const input = command?.trim()
  if (!input) {
    return null
  }
  const backslashEscapes = (options.platform ?? process.platform) !== 'win32'
  let index = 0
  let quote: string | null = null
  let token = ''
  while (index < input.length) {
    const char = input[index]
    if (quote) {
      if (char === quote) {
        quote = null
      } else if (char === '\\' && quote === '"' && backslashEscapes && index + 1 < input.length) {
        index += 1
        token += input[index]
      } else {
        token += char
      }
    } else if (QUOTES.has(char)) {
      quote = char
    } else if (/\s/.test(char)) {
      break
    } else if (char === '\\' && backslashEscapes && index + 1 < input.length) {
      index += 1
      token += input[index]
    } else {
      token += char
    }
    index += 1
  }
  return token.length > 0 ? token : null
}

export function hasPathSeparatorToken(token: string): boolean {
  return token.includes('/') || token.includes('\\')
}

export function isSafeExecutableBasename(token: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(token)
}

export function isSafeOverrideExecutableToken(token: string): boolean {
  if (token.includes('\0')) {
    return false
  }
  if (!hasPathSeparatorToken(token)) {
    return isSafeExecutableBasename(token)
  }
  return (
    !token.includes('..') &&
    !/[|&;<>(){}[\]$`"'*!?]/.test(token) &&
    /^[A-Za-z0-9._+\-/:\\~ ]+$/.test(token)
  )
}
