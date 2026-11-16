import { normalizeComputerAwakeMode, type ComputerAwakeMode } from '../computer-awake-mode'
import type { GlobalSettings } from '../global-settings-types'
import type { ZotzNodeSetupResult, ZotzNodeSetupStepId } from './zotz-node-setup-contract'

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

/** Server mode and pairing links require a connected tailnet, a non-failing firewall step, and active exposure. */
export function isZotzServerAccessReady(result: ZotzNodeSetupResult | null | undefined): boolean {
  if (!result?.tailscaleIp) {
    return false
  }
  const status = (id: ZotzNodeSetupStepId) => result.steps.find((step) => step.id === id)?.status
  const firewall = status('firewall')
  return (
    status('tailscale') === 'done' &&
    (firewall === 'done' || firewall === 'skipped') &&
    status('networkExposure') === 'done'
  )
}

/**
 * Same first-run policy as upstream onboarding: automated launches (ORCA_E2E_USER_DATA_DIR, set by
 * the Playwright and packaged e2e drivers) and dev builds never get the wizard on their own;
 * ORCA_DEV_SHOW_FIRST_RUN_EDUCATION=1 brings it back in dev. Settings can always open it.
 */
export function shouldAutoShowZotzMachineModeWizard(input: {
  e2eUserDataDir: string | undefined
  devBuild: boolean
  showFirstRunEducation: string | undefined
}): boolean {
  if (input.e2eUserDataDir) {
    return false
  }
  return !input.devBuild || input.showFirstRunEducation === '1'
}
