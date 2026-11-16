import { normalizeComputerAwakeMode, type ComputerAwakeMode } from '../computer-awake-mode'
import type { GlobalSettings } from '../global-settings-types'

export type ZotzMachineMode = NonNullable<GlobalSettings['zotzMachineMode']>

export const ZOTZ_MACHINE_MODES = [
  'unset',
  'personal',
  'server'
] as const satisfies readonly ZotzMachineMode[]

type ZotzMachineModeSettings = {
  zotzMachineMode?: ZotzMachineMode
  computerAwakeMode?: ComputerAwakeMode
  keepComputerAwakeWhileAgentsRun?: boolean
}

export function resolveZotzMachineMode(
  settings: Pick<ZotzMachineModeSettings, 'zotzMachineMode'> | null | undefined
): ZotzMachineMode {
  const persisted = settings?.zotzMachineMode
  return ZOTZ_MACHINE_MODES.find((mode) => mode === persisted) ?? 'unset'
}

/** A remote server node must never sleep, whatever the per-agent awake preference says. */
export function resolveZotzComputerAwakeMode(settings: ZotzMachineModeSettings): ComputerAwakeMode {
  if (resolveZotzMachineMode(settings) === 'server') {
    return 'on'
  }
  return normalizeComputerAwakeMode(
    settings.computerAwakeMode,
    settings.keepComputerAwakeWhileAgentsRun
  )
}

/** A server listens beyond loopback from startup, refusing public sources like `serve --refuse-public`. */
export function zotzServerNetworkSources(
  settings: Pick<ZotzMachineModeSettings, 'zotzMachineMode'> | null | undefined
): { allowPublic: false; refusePublic: true; pairingAddress: null } | null {
  return resolveZotzMachineMode(settings) === 'server'
    ? { allowPublic: false, refusePublic: true, pairingAddress: null }
    : null
}
