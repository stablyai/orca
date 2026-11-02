import { quotePowerShellLiteral } from '../../src/shared/powershell-native-argument'
import { quotePosixShell } from '../../src/shared/wsl-login-shell-command'

function quoteTerminalArg(value: string): string {
  return process.platform === 'win32' ? quotePowerShellLiteral(value) : quotePosixShell(value)
}

export function nodeTerminalCommand(args: readonly string[]): string {
  const nodeExecutable = quoteTerminalArg(process.execPath)
  const executable = process.platform === 'win32' ? `& ${nodeExecutable}` : nodeExecutable

  // Why: Windows CI shells do not always inherit setup-node's PATH, so E2E
  // terminal probes must invoke the runner's Node executable directly.
  return [executable, ...args.map(quoteTerminalArg)].join(' ')
}
