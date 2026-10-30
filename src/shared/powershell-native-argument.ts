export function quotePowerShellLiteral(value: string): string {
  if (/[\r\n]/.test(value)) {
    return quotePowerShellMultilineLiteral(value)
  }
  // Why: PowerShell also ends single-quoted strings at typographic single quotes.
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`
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
 * For cmd/naive quote counting, double quotes as process-host/windows-command-line.ts does; backslash-quote changes cmd parity
 * and could expose a later & as an operator. */
export function getPowerShellEscapeNativeArgsFunction(): string {
  return `function Global:__OrcaEscapeNativeArgs([string]$Program, [object[]]$Arguments) {
    Set-StrictMode -Off
    $mode = $PSNativeCommandArgumentPassing
    $cmd = $Program -match '\\.(bat|cmd)$'
    if ($mode -eq 'Standard' -or ($mode -eq 'Windows' -and -not $cmd)) { return $Arguments }
    $selfQuote = $cmd -or $PSVersionTable.PSVersion.Major -lt 6
    foreach ($arg in $Arguments) {
        if ($arg -isnot [string] -or $arg -notmatch '["\\\\]') { $arg; continue }
        if ($selfQuote) { '"' + (($arg -replace '(\\\\*)"', '$1$1""') -replace '(\\\\+)\\z', '$1$1') + '"' }
        else { $arg -replace '(\\\\*)"', '$1$1\\"' }
    }
}`
}

export function quotePowerShellNativeArgument(value: string): string {
  // PowerShell 5.1 drops unescaped embedded quotes when constructing native argv (e.g. wsl.exe).
  return quotePowerShellLiteral(value.replace(/(\\*)"/g, '$1$1\\"'))
}
