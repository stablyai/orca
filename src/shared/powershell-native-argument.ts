export function quotePowerShellLiteral(value: string): string {
  if (/[\r\n]/.test(value)) {
    return quotePowerShellMultilineLiteral(value)
  }
  // Why: PowerShell also ends single-quoted strings at typographic single quotes.
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`
}

/**
 * Why one physical line: a raw line break typed into PowerShell submits the line, and Windows
 * PowerShell 5.1 without PSReadLine then waits at `>>` for an empty line that never comes.
 * Backtick escapes keep every byte, so `\r\n` stays `\r\n` exactly as the single-quoted form
 * delivered it.
 */
function quotePowerShellMultilineLiteral(value: string): string {
  const escaped = value.replace(/[`$"\u201C\u201D\u201E\r\n]/g, (char) =>
    char === '\r' ? '`r' : char === '\n' ? '`n' : `\`${char}`
  )
  return `"${escaped}"`
}

export function quotePowerShellNativeArgument(value: string): string {
  // Why: Windows PowerShell 5.1 drops unescaped embedded quotes when it
  // constructs argv for native executables such as wsl.exe.
  return quotePowerShellLiteral(value.replace(/(\\*)"/g, '$1$1\\"'))
}
