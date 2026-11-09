import { isWslShellName } from '../local-windows-terminal-runtime'
import { parseWslUncPath } from '../wsl-paths'

export type TerminalWslContext = { distro: string; treatPosixCwdAsWsl: true }
export type EffectiveTerminalExecutionContext =
  | { kind: 'native' }
  | { kind: 'wsl'; context: TerminalWslContext }
  | { kind: 'unresolved-wsl' }

/** Select execution without preparing a shell, directory, or environment. */
export function selectEffectiveTerminalExecutionContext(args: {
  platform: NodeJS.Platform
  cwd?: string
  worktreeContext?: TerminalWslContext
  shell?: string
  preferredDistro?: string | null
  defaultDistro?: string | null
}): EffectiveTerminalExecutionContext {
  if (args.platform !== 'win32') {
    return { kind: 'native' }
  }
  const cwdDistro = args.cwd ? parseWslUncPath(args.cwd)?.distro : undefined
  const authoritative = cwdDistro ?? args.worktreeContext?.distro
  if (authoritative) {
    return { kind: 'wsl', context: { distro: authoritative, treatPosixCwdAsWsl: true } }
  }
  if (!isWslShellName(args.shell)) {
    return { kind: 'native' }
  }
  const distro = args.preferredDistro?.trim() || args.defaultDistro?.trim()
  return distro
    ? { kind: 'wsl', context: { distro, treatPosixCwdAsWsl: true } }
    : { kind: 'unresolved-wsl' }
}

export const TERMINAL_EXECUTION_CONTEXT_UNRESOLVED = 'terminal_execution_context_unresolved'
