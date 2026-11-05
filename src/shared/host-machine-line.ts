import { hostPlatformDisplayName } from './host-platform-label'

export const HOST_MACHINE_KINDS = ['laptop', 'desktop', 'server'] as const

export type HostMachineKind = (typeof HOST_MACHINE_KINDS)[number]

/** What kind of computer the desktop runs on; `model` is a marketing name like "MacBook Pro". */
export type HostMachine = { kind: HostMachineKind; model: string | null }

export function sameHostMachine(a: HostMachine | null, b: HostMachine | null): boolean {
  return a === b || (a !== null && b !== null && a.kind === b.kind && a.model === b.model)
}

const KIND_LABELS: Record<HostMachineKind, string> = {
  laptop: 'Laptop',
  desktop: 'Desktop',
  server: 'Server'
}

/** "MacBook Pro · macOS", "Server · Linux", or the OS alone for desktops that predate machine info. */
export function formatHostMachineLine(
  machine: HostMachine | null | undefined,
  platform: NodeJS.Platform | null | undefined
): string | null {
  const machineLabel = machine ? machine.model?.trim() || KIND_LABELS[machine.kind] : null
  return [machineLabel, hostPlatformDisplayName(platform)].filter(Boolean).join(' · ') || null
}
