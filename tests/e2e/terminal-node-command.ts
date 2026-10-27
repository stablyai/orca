import { quotePowerShellLiteral } from '../../src/shared/powershell-native-argument'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'

function quoteTerminalArg(value: string): string {
  return process.platform === 'win32' ? quotePowerShellLiteral(value) : quotePosixShell(value)
}

export function nodeTerminalCommand(args: readonly string[]): string {
  const nodeExecutable = quoteTerminalArg(process.execPath)
  const executable = process.platform === 'win32' ? `& ${nodeExecutable}` : nodeExecutable

  // Pin the runner’s Node executable because Windows CI shells may not inherit setup-node’s PATH.
  return [executable, ...args.map(quoteTerminalArg)].join(' ')
}
