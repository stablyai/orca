function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function quotePowerShellArg(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function quoteTerminalArg(value: string): string {
  return process.platform === 'win32' ? quotePowerShellArg(value) : quotePosixShellArg(value)
}

export function nodeTerminalCommand(args: readonly string[]): string {
  const nodeExecutable = quoteTerminalArg(process.execPath)
  const executable = process.platform === 'win32' ? `& ${nodeExecutable}` : nodeExecutable

  // Why: Windows CI shells do not always inherit setup-node's PATH, so E2E
  // terminal probes must invoke the runner's Node executable directly.
  return [executable, ...args.map(quoteTerminalArg)].join(' ')
}
