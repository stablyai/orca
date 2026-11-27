const SINGLE_QUOTES = "'‘’‚‛"
const SINGLE_QUOTE_PATTERN = new RegExp(`[${SINGLE_QUOTES}]`, 'g')

export function isPowerShellSingleQuote(char: string): boolean {
  return char.length === 1 && SINGLE_QUOTES.includes(char)
}

export function quotePowerShellLiteral(value: string): string {
  if (/[\r\n]/.test(value)) {
    return quotePowerShellMultilineLiteral(value)
  }
  // Why: PowerShell also ends single-quoted strings at typographic single quotes.
  return `'${value.replace(SINGLE_QUOTE_PATTERN, '$&$&')}'`
}

/** Raw newlines submit PowerShell input and strand 5.1 without PSReadLine at >>. Backtick escapes keep one physical line
 * while preserving CR/LF bytes exactly. */
function quotePowerShellMultilineLiteral(value: string): string {
  const escaped = value.replace(/[`$"\u201C\u201D\u201E\r\n]/g, (char) =>
    char === '\r' ? '`r' : char === '\n' ? '`n' : `\`${char}`
  )
  return `"${escaped}"`
}

/** Runtime PowerShell mode decides argv escaping: 5.1/pre-7.3 legacy modes drop embedded quotes, while newer modes escape them.
 * For cmd/naive quote counting, double quotes; backslash-quote changes cmd parity
 * and could expose a later & as an operator. */
export function getPowerShellEscapeNativeArgsFunction(options?: { inline: boolean }): string {
  const scope = options?.inline ? 'local' : 'Global'
  const separator = options?.inline ? ';' : ''
  const source = `function ${scope}:__OrcaEscapeNativeArgs([string]$Program, [object[]]$Arguments) {
    Set-StrictMode -Off${separator}
    $mode = $PSNativeCommandArgumentPassing${separator}
    $cmd = $Program -match '\\.(bat|cmd)$'${separator}
    if ($mode -eq 'Standard' -or ($mode -eq 'Windows' -and -not $cmd)) { return $Arguments }${separator}
    $selfQuote = $cmd -or $PSVersionTable.PSVersion.Major -lt 6${separator}
    foreach ($arg in $Arguments) {
        if ($arg -isnot [string] -or $arg -notmatch '["\\\\]') { $arg; continue }${separator}
        if ($selfQuote) { '"' + (($arg -replace '(\\\\*)"', '$1$1""') -replace '(\\\\+)\\z', '$1$1') + '"' }
        else { $arg -replace '(\\\\*)"', '$1$1\\"' }
    }
}`
  return options?.inline ? source.replace(/\s*\n\s*/g, ' ') : source
}

export function quotePowerShellNativeArgument(value: string): string {
  // PowerShell 5.1 drops unescaped embedded quotes when constructing native argv (e.g. wsl.exe).
  return quotePowerShellLiteral(value.replace(/(\\*)"/g, '$1$1\\"'))
}
