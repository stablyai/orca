import { buildReceivingHermesQueryCommand } from './hermes-startup-query'
import { readLaunchPosition } from './launch-position'
import { isFreshOmpLaunchCommand, prepareFreshOmpLaunch } from './omp-fresh-launch'
import { quoteStartupArg, type AgentStartupShell } from './tui-agent-startup-shell'

export type ReceivingShell = 'bash' | 'zsh' | 'sh' | 'fish' | 'powershell'

export type ReceivingShellCheck = {
  shell: ReceivingShell
  name: string
  path: string
  hermesArgs?: readonly string[]
}

export const RECEIVING_SHELL_LAUNCH_ENV = 'ORCA_RECEIVING_SHELL_LAUNCH'

export function receivingShellDialect(
  shell: AgentStartupShell,
  platform: NodeJS.Platform,
  shellPath = '/bin/zsh'
): ReceivingShell | undefined {
  if (shell !== 'posix') {
    return shell === 'powershell' ? shell : undefined
  }
  if (platform === 'win32') {
    return 'bash'
  }
  const name = shellPath.split('/').at(-1)?.toLowerCase()
  switch (name) {
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'sh':
      return name
    case 'dash':
      return 'sh'
    default:
      return undefined
  }
}

export function receivingShellLaunchFromEnv(shell: ReceivingShell): string {
  if (shell === 'powershell') {
    return `Invoke-Expression ('Remove-Item Env:${RECEIVING_SHELL_LAUNCH_ENV}; ' + $env:${RECEIVING_SHELL_LAUNCH_ENV})`
  }
  const clear =
    shell === 'fish'
      ? `set -eg ${RECEIVING_SHELL_LAUNCH_ENV}`
      : `unset ${RECEIVING_SHELL_LAUNCH_ENV}`
  return `eval '${clear}; '"$${RECEIVING_SHELL_LAUNCH_ENV}"`
}

function renderBranches(check: ReceivingShellCheck, bare: string, fallback: string): string {
  const { shell, name } = check
  if (shell === 'powershell') {
    const path = quoteStartupArg(check.path, shell)
    const lookup = `(Get-Command -CommandType Application ${name} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)`
    return `if (${lookup} -ceq ${path}) { ${bare} } else { ${fallback} }`
  }
  const path = quoteStartupArg(check.path, 'posix')
  if (shell === 'fish') {
    return `if builtin contains -- ${path} (command -s ${name} | builtin string collect); ${bare}; else; ${fallback}; end`
  }
  const lookup =
    shell === 'bash'
      ? `builtin type -P -- ${name}`
      : shell === 'zsh'
        ? `builtin whence -p -- ${name}`
        : `unalias ${name} 2>/dev/null || :; unset -f ${name} 2>/dev/null || :; command -v ${name}`
  return `if command test "$(${lookup})" = ${path} && command test -x ${path}; then ${bare}; else ${fallback}; fi`
}

export async function renderReceivingShellLaunch(
  check: ReceivingShellCheck,
  command: string,
  fallback: string
): Promise<string> {
  if (check.hermesArgs) {
    const bare = buildReceivingHermesQueryCommand([check.name, ...check.hermesArgs], check.shell)
    return renderBranches(check, bare, fallback)
  }
  const syntax = check.shell === 'powershell' ? 'powershell' : 'posix'
  const render = (inner: string, prepared: string): string => {
    const launch = readLaunchPosition(inner, syntax)
    if (!launch || launch.executable !== check.path || launch.bypassesShellFunction) {
      return prepared
    }
    const prefix = inner.slice(0, launch.invocationStart)
    const assignments = syntax === 'posix' ? inner.slice(launch.invocationStart, launch.start) : ''
    const bare = assignments + check.name + inner.slice(launch.end)
    return prefix + renderBranches(check, bare, prepared.slice(prefix.length))
  }
  return command === fallback && isFreshOmpLaunchCommand(command)
    ? prepareFreshOmpLaunch(command, syntax, async (inner) => render(inner, inner))
    : render(command, fallback)
}
