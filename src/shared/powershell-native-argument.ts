export function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function quotePowerShellNativeArgument(value: string): string {
  // Why: Windows PowerShell 5.1 drops unescaped embedded quotes when it
  // constructs argv for native executables such as wsl.exe.
  return quotePowerShellLiteral(value.replace(/(\\*)"/g, '$1$1\\"'))
}
