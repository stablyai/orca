import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  CheckedPortableSettings,
  PortableSettings,
  PortableSettingsImportResult
} from '../../../../../../shared/portable-settings'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { isRuntimeEnvironmentPairingChangedError } from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'

/** `send` copies this computer's settings to the paired Orca; `receive` brings its settings here. */
export type SettingsCopyDirection = 'send' | 'receive'

export type SettingsCopyCall = <TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  /** A paired Orca refuses the call when it was paired again after this revision. */
  options?: { expectedEnvironmentPairingRevision?: number }
) => Promise<TResult>

export type SettingsCopyPreview = PortableSettingsImportResult & {
  /** The settings the preview checked; applying sends these, so the copy matches what was shown. */
  settings: PortableSettings
  /** Settings the sending Orca kept back, such as a custom terminal theme. */
  notSent: string[]
  /** The paired Orca's pairing when the preview ran; applying is refused after a re-pair. */
  pairingRevision: number | undefined
}

export function settingsCopyTargets(
  environmentId: string,
  direction: SettingsCopyDirection
): { from: RuntimeClientTarget; to: RuntimeClientTarget } {
  const here: RuntimeClientTarget = { kind: 'local' }
  const paired: RuntimeClientTarget = { kind: 'environment', environmentId }
  return direction === 'send' ? { from: here, to: paired } : { from: paired, to: here }
}

/** Reads the sending Orca's settings and asks the receiving one what they would change. */
export async function previewSettingsCopy(
  call: SettingsCopyCall,
  environmentId: string,
  direction: SettingsCopyDirection
): Promise<SettingsCopyPreview> {
  const { from, to } = settingsCopyTargets(environmentId, direction)
  // Captured before any await, so both reads and the later write reach the same pairing.
  const pairingRevision = captureRuntimeEnvironmentRequestRevision(environmentId)
  const pinned = { expectedEnvironmentPairingRevision: pairingRevision }
  const exported = await call<CheckedPortableSettings>(
    from,
    'settings.exportPortable',
    undefined,
    pinned
  )
  const preview = await call<PortableSettingsImportResult>(
    to,
    'settings.importPortable',
    { settings: exported.settings, dryRun: true },
    pinned
  )
  return { ...preview, settings: exported.settings, notSent: exported.skipped, pairingRevision }
}

/** Writes exactly what the preview checked, to the Orca the preview checked. */
export function applySettingsCopy(
  call: SettingsCopyCall,
  environmentId: string,
  direction: SettingsCopyDirection,
  preview: Pick<SettingsCopyPreview, 'settings' | 'pairingRevision'>
): Promise<PortableSettingsImportResult> {
  const { to } = settingsCopyTargets(environmentId, direction)
  return call<PortableSettingsImportResult>(
    to,
    'settings.importPortable',
    { settings: preview.settings, dryRun: false },
    { expectedEnvironmentPairingRevision: preview.pairingRevision }
  )
}

/** An Orca released before settings copy answers its methods as unknown. */
export function isSettingsCopyUnsupported(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

/** The paired Orca was paired again after the preview, so the preview may describe another Orca. */
export function isSettingsCopyPairingChanged(error: unknown): boolean {
  return isRuntimeEnvironmentPairingChangedError(error)
}
