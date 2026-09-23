import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../../shared/execution-host-registry'
import type { SidebarHostOption } from './sidebar-host-options'
import { translate } from '@/i18n/i18n'

/**
 * WSL distro rows for the Add Project host selector.
 *
 * Why not an ExecutionHostKind: `wsl:<distro>` entries are presentation-level
 * sub-rows of the Local Windows host — the dialog keeps host=local and carries
 * the distro as session state (repo paths land on `\\wsl.localhost\<distro>`
 * UNC, and the project's `localWindowsRuntimePreference` is written on add).
 * Promoting WSL to a fourth ExecutionHostKind would ripple through the shared
 * host-id grammar, repo persistence, and every sidebar surface.
 */

export const WSL_DISTRO_OPTION_PREFIX = 'wsl-distro:'

export type AddProjectWslDistroOption = {
  /** Dialog-local option key — never persisted as a repo's ExecutionHostId. */
  id: `wsl-distro:${string}`
  kind: 'wsl-distro'
  wslDistro: string
  label: string
  detail: string
  health: ExecutionHostHealth
}

/** Anything the Add Project host selector can render. */
export type AddProjectHostOption = SidebarHostOption | AddProjectWslDistroOption

export function isAddProjectWslDistroOption(
  option: AddProjectHostOption
): option is AddProjectWslDistroOption {
  return option.kind === 'wsl-distro'
}

export function toWslDistroOptionId(distro: string): `wsl-distro:${string}` {
  return `wsl-distro:${distro}`
}

/** Null when the id is a plain ExecutionHostId (local/ssh/runtime). */
export function parseWslDistroOptionId(optionId: string): string | null {
  if (!optionId.startsWith(WSL_DISTRO_OPTION_PREFIX)) {
    return null
  }
  const distro = optionId.slice(WSL_DISTRO_OPTION_PREFIX.length)
  return distro || null
}

export function buildAddProjectWslDistroOptions(args: {
  distros: readonly string[]
  runningDistros: ReadonlySet<string>
}): AddProjectWslDistroOption[] {
  return args.distros.map((distro) => {
    const running = args.runningDistros.has(distro)
    return {
      id: toWslDistroOptionId(distro),
      kind: 'wsl-distro' as const,
      wslDistro: distro,
      label: translate(
        'auto.components.sidebar.addProjectWslHost.wslDistroLabel',
        'WSL · {{distro}}',
        { distro }
      ),
      detail: running
        ? translate(
            'auto.components.sidebar.addProjectWslHost.wslDistroRunning',
            'Windows Linux subsystem · ready'
          )
        : translate(
            'auto.components.sidebar.addProjectWslHost.wslDistroNotRunning',
            'Windows Linux subsystem · start on first use'
          ),
      health: running ? 'available' : 'disconnected'
    }
  })
}

/** Sort key: Local Windows first, then WSL distros, then ssh/runtime hosts. */
export function addProjectHostOptionOrder(option: AddProjectHostOption): number {
  if (option.kind === 'wsl-distro') {
    return 1
  }
  return option.id === LOCAL_EXECUTION_HOST_ID ? 0 : 2
}
