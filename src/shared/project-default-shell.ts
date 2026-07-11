import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'
import { isWslRuntimeResolution } from './wsl-repo-identity'

export type ProjectDefaultShell = 'inherit' | 'powershell' | 'wsl' | 'cmd' | 'git-bash'
const VALUES: ProjectDefaultShell[] = ['inherit', 'powershell', 'wsl', 'cmd', 'git-bash']
const SHELL: Record<'powershell' | 'cmd' | 'git-bash', string> = {
  powershell: 'powershell.exe',
  cmd: 'cmd.exe',
  'git-bash': 'git-bash'
}

export function normalizeProjectDefaultShell(v: unknown): ProjectDefaultShell {
  return typeof v === 'string' && (VALUES as string[]).includes(v)
    ? (v as ProjectDefaultShell)
    : 'inherit'
}

export function resolveDefaultShell(args: {
  creationOverride?: string
  projectDefaultShell: ProjectDefaultShell
  runtime: ProjectExecutionRuntimeResolution | undefined
  globalDefaultShell?: string
}): string | undefined {
  // Policy: WSL projects (and repair-required) stay on WSL regardless of overrides.
  if (isWslRuntimeResolution(args.runtime) || args.runtime?.status === 'repair-required') {
    return 'wsl.exe'
  }
  // Windows-host branch only below. 'wsl' is not a valid host shell here (T6 omits it, and
  // getHostShellForProjectRuntime strips WSL names for windows-host) — treat it as inherit.
  if (args.creationOverride && args.creationOverride !== 'wsl.exe') {
    return args.creationOverride
  }
  if (args.projectDefaultShell !== 'inherit' && args.projectDefaultShell !== 'wsl') {
    return SHELL[args.projectDefaultShell]
  }
  return args.globalDefaultShell
}
