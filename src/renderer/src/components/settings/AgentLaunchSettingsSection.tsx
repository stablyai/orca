import { toast } from 'sonner'
import { getAgentLabel } from '@/lib/agent-catalog'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { wholeAgentEnvironmentUpdates } from '../../../../shared/agent-launch-permission-updates'
import { useRef } from 'react'
import { useAppStore } from '@/store'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  AgentLaunchSettingsCatalog,
  AgentLaunchSettingsLoading,
  type AgentPermissionsRenderer
} from './AgentLaunchSettingsCatalog'
import { HostAgentLaunchSettings } from './HostAgentLaunchSettings'
import { SettingsHostScopeUnavailableNotice } from './SettingsHostScopePicker'
import type { SettingsHostScope } from './settings-host-scope'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { translate } from '@/i18n/i18n'

export function AgentLaunchSettingsSection({
  settings,
  updateSettings,
  hostScope,
  renderPermissions
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  /** Host chosen in the Settings host menu; launch settings are edited in that host's store. */
  hostScope: SettingsHostScope
  renderPermissions: AgentPermissionsRenderer
}): React.JSX.Element {
  const environmentId = runtimeTargetEnvironmentId(hostScope.target)
  const environment = useAppStore((state) =>
    environmentId ? state.runtimeEnvironments.find((entry) => entry.id === environmentId) : null
  )
  return (
    <section className="space-y-8">
      {!environmentId ? (
        <LocalAgentLaunchSettings
          settings={settings}
          updateSettings={updateSettings}
          renderPermissions={renderPermissions}
        />
      ) : environment ? (
        <HostAgentLaunchSettings
          key={`${environmentId}:${environment.pairingRevision ?? environment.createdAt}`}
          environmentId={environmentId}
          pairingRevision={environment.pairingRevision ?? environment.createdAt}
          hostName={environment.name}
          renderPermissions={renderPermissions}
        />
      ) : !hostScope.available ? (
        <SettingsHostScopeUnavailableNotice />
      ) : (
        <AgentLaunchSettingsLoading />
      )}
    </section>
  )
}

function LocalAgentLaunchSettings({
  settings,
  updateSettings,
  renderPermissions
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  renderPermissions: AgentPermissionsRenderer
}): React.JSX.Element {
  const tail = useRef<Promise<void> | null>(null)
  const apply = (
    agent: TuiAgent | undefined,
    compute: (current: GlobalSettings, platform: NodeJS.Platform) => Partial<GlobalSettings>
  ): Promise<void> => {
    const write = (tail.current ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = useAppStore.getState().settings ?? settings
        const updates = compute(current, window.api.platform.get().platform)
        if (Object.keys(updates).length) {
          await useAppStore.getState().updateSettingsOrThrow(updates)
        }
      })
      .catch((error: unknown) => {
        toast.error(
          agent
            ? translate(
                'settings.agents.localSaveFailedAgent',
                '{{agent}} settings could not be saved. Try again.',
                { agent: getAgentLabel(agent) }
              )
            : translate(
                'settings.agents.localSaveFailed',
                'Agent settings could not be saved. Try again.'
              )
        )
        throw error
      })
    tail.current = write
    return write
  }
  const mutate = (mutation: AgentLaunchSettingsMutation): Promise<void> =>
    apply(
      mutation.type !== 'default' && 'agent' in mutation ? mutation.agent : undefined,
      (current, platform) => agentLaunchSettingsMutationUpdates(current, mutation, platform)
    )
  const saveEnvironment = (agent: TuiAgent, requested: Record<string, string>): Promise<void> =>
    apply(agent, (current, platform) =>
      wholeAgentEnvironmentUpdates(current, agent, requested, platform)
    )

  return (
    <AgentLaunchSettingsCatalog
      settings={projectAgentLaunchSettings(settings, window.api.platform.get().platform)}
      mutate={mutate}
      detectionTarget={LOCAL_DETECTION_TARGET}
      hostName={null}
      renderPermissions={renderPermissions}
      nativeChatPermissionsSupported
      local={{ settings, updateSettings, saveEnvironment }}
    />
  )
}

const LOCAL_DETECTION_TARGET = { kind: 'local' } as const
