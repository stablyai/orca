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

/**
 * PowerShell function that escapes arguments for `$Program`, for Orca's agent wrappers to splat.
 *
 * Why at runtime: the escaping depends on the PowerShell reading the line. Legacy argv passing
 * (Windows PowerShell 5.1, pwsh before 7.3, and 7.3's `Windows` mode for `.cmd`/`.bat`) leaves
 * embedded `"` unescaped, so the program drops them; otherwise PowerShell escapes them itself and
 * must get the text untouched.
 *
 * Where cmd.exe reads the line, or Windows PowerShell decides quoting by counting `"` naively, the
 * argument is quoted here with `""` for each quote, as process-host's windows-command-line.ts does:
 * a `\"` would flip cmd's quote parity and turn a later `&` into an operator.
 */
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
  // Why: Windows PowerShell 5.1 drops unescaped embedded quotes when it
  // constructs argv for native executables such as wsl.exe.
  return quotePowerShellLiteral(value.replace(/(\\*)"/g, '$1$1\\"'))
}
