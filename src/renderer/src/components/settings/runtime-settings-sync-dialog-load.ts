import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import {
  createPortableSettingsBundle,
  type PortableSettingsBundle,
  type PortableSettingsCategory
} from '../../../../shared/portable-settings'
import type { AgentInstallPlatform } from '../../../../shared/tui-agent-install-commands'
import { diffMissingInstallableAgents } from '../../../../shared/tui-agent-install-commands'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'

type PortableSettingsGetResult = { bundle: PortableSettingsBundle }

export type RuntimeSettingsSyncLoadResult = {
  localBundle: PortableSettingsBundle
  remoteBundle: PortableSettingsBundle
  selected: PortableSettingsCategory[]
  installable: TuiAgent[]
  manualOnly: TuiAgent[]
}

export async function loadRuntimeSettingsSyncDialogState(args: {
  environmentId: string
  settings: GlobalSettings
  configuredCategories: PortableSettingsCategory[]
  supportsAgentInstall: boolean
  installPlatform: AgentInstallPlatform | null
  ensureDetectedAgents: () => Promise<TuiAgent[]>
  ensureRuntimeDetectedAgents: (environmentId: string) => Promise<TuiAgent[]>
}): Promise<RuntimeSettingsSyncLoadResult> {
  const agentProbe = args.supportsAgentInstall
    ? Promise.all([
        args.ensureDetectedAgents(),
        args.ensureRuntimeDetectedAgents(args.environmentId)
      ]).then(([localAgents, remoteAgents]) => {
        if (!args.installPlatform) {
          return { installable: [] as TuiAgent[], manualOnly: [] as TuiAgent[] }
        }
        return diffMissingInstallableAgents({
          localDetected: localAgents,
          remoteDetected: remoteAgents,
          platform: args.installPlatform
        })
      })
    : Promise.resolve({ installable: [] as TuiAgent[], manualOnly: [] as TuiAgent[] })

  const [keybindings, remote, agentDiff] = await Promise.all([
    window.api.keybindings.get(),
    callRuntimeRpc<PortableSettingsGetResult>(
      { kind: 'environment', environmentId: args.environmentId },
      'settings.portable.get',
      undefined,
      { timeoutMs: 15_000 }
    ),
    agentProbe
  ])

  return {
    localBundle: createPortableSettingsBundle(args.settings, keybindings),
    remoteBundle: remote.bundle,
    selected: args.configuredCategories,
    installable: agentDiff.installable,
    manualOnly: agentDiff.manualOnly
  }
}

export function formatRuntimeSettingsSyncLoadError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : translate(
        'auto.components.settings.RuntimeSettingsSyncDialog.loadFailed',
        'Could not compare settings with this server.'
      )
}
