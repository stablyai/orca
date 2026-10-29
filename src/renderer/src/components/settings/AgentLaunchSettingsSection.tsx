import { useChatSettingsOwnPermissions } from '@/runtime/structured-agent-session-host-capability'
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
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  useAgentPermissionOverrideNotice,
  type SelectPermissionOverrides
} from './agent-permission-override-notice'

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
  const notify = useAgentPermissionOverrideNotice()
  const chatOwnSupported = useChatSettingsOwnPermissions()
  const tail = useRef<Promise<void> | null>(null)
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const write = (tail.current ?? Promise.resolve()).catch(() => {}).then(operation)
    tail.current = write
    return write
  }
  const current = () => useAppStore.getState().settings ?? settings
  const permissions = (latest = current()) => {
    return latest.agentPermissionDefault
      ? { default: latest.agentPermissionDefault, overrides: latest.agentPermissionOverrides ?? {} }
      : undefined
  }
  const failed = (agent: TuiAgent | undefined) => (error: unknown) => {
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
  }
  const write = (
    agent: TuiAgent | undefined,
    compute: (current: GlobalSettings, platform: NodeJS.Platform) => Partial<GlobalSettings>
  ): Promise<GlobalSettings> => {
    return Promise.resolve()
      .then(async () => {
        const latest = current()
        const updates = compute(latest, window.api.platform.get().platform)
        let acknowledged = latest
        if (Object.keys(updates).length) {
          await useAppStore.getState().updateSettingsOrThrow(updates, (settings) => {
            acknowledged = settings
          })
        }
        return acknowledged
      })
      .catch(failed(agent))
  }
  const apply = (agent: TuiAgent | undefined, compute: Parameters<typeof write>[1]) =>
    enqueue(async () => {
      await write(agent, compute)
    })
  const follow = (select: SelectPermissionOverrides) =>
    enqueue(async () => {
      let agent: TuiAgent | undefined
      let attempted = false
      try {
        for (agent of select(permissions(await window.api.settings.get()))) {
          if (select(permissions(await window.api.settings.get())).includes(agent)) {
            attempted = true
            await callRuntimeRpc(LOCAL_DETECTION_TARGET, 'settings.mutateAgentLaunch', {
              type: 'permission',
              agent,
              choice: 'default'
            })
          }
        }
      } catch (error) {
        failed(agent)(error)
      } finally {
        if (attempted) {
          await useAppStore.getState().fetchSettings({ deferOwnerWorktreeVisibilityDefaults: true })
        }
      }
    })
  const mutate = (mutation: AgentLaunchSettingsMutation): Promise<void> =>
    enqueue(async () => {
      const before = permissions()
      const after = await write(
        mutation.type !== 'default' && 'agent' in mutation ? mutation.agent : undefined,
        (latest, platform) => agentLaunchSettingsMutationUpdates(latest, mutation, platform)
      )
      notify(before, permissions(after), mutation, follow)
    })
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
      chatOwnSupported={chatOwnSupported}
      local={{ settings, updateSettings, saveEnvironment }}
    />
  )
}

const LOCAL_DETECTION_TARGET = { kind: 'local' } as const
