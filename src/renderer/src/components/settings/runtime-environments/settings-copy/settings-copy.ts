import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  CheckedPortableSettings,
  PortableSettings,
  PortableSettingsImportResult
} from '../../../../../../shared/portable-settings'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'

/** `send` copies this computer's settings to the paired Orca; `receive` brings its settings here. */
export type SettingsCopyDirection = 'send' | 'receive'

export type SettingsCopyCall = <TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown
) => Promise<TResult>

export type SettingsCopyPreview = PortableSettingsImportResult & {
  /** The settings the preview checked; applying sends these, so the copy matches what was shown. */
  settings: PortableSettings
  /** Settings the sending Orca kept back, such as a custom terminal theme. */
  notSent: string[]
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
  const exported = await call<CheckedPortableSettings>(from, 'settings.exportPortable')
  const preview = await call<PortableSettingsImportResult>(to, 'settings.importPortable', {
    settings: exported.settings,
    dryRun: true
  })
  return { ...preview, settings: exported.settings, notSent: exported.skipped }
}

export function applySettingsCopy(
  call: SettingsCopyCall,
  environmentId: string,
  direction: SettingsCopyDirection,
  settings: PortableSettings
): Promise<PortableSettingsImportResult> {
  const { to } = settingsCopyTargets(environmentId, direction)
  return call<PortableSettingsImportResult>(to, 'settings.importPortable', {
    settings,
    dryRun: false
  })
}

/** An Orca released before settings copy answers its methods as unknown. */
export function isSettingsCopyUnsupported(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}
