import { useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { runtimeTargetForExecutionHostId } from '@/runtime/runtime-client-target'
import { useSidebarHostScopeOptions } from '../sidebar/use-sidebar-host-scope-options'
import { pickerExecutionHosts } from '../../../../shared/managed-orcad-execution-host'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsRow } from './SettingsFormControls'
import {
  AgentLaunchSettingsCatalog,
  type AgentPermissionsRenderer
} from './AgentLaunchSettingsCatalog'
import { HostAgentLaunchSettings } from './HostAgentLaunchSettings'
import { translate } from '@/i18n/i18n'

export function AgentLaunchSettingsSection({
  settings,
  updateSettings,
  renderPermissions
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  renderPermissions: AgentPermissionsRenderer
}): React.JSX.Element {
  const { hostOptions } = useSidebarHostScopeOptions()
  const hosts = pickerExecutionHosts(hostOptions)
  const initialHost = useAppStore((state) => {
    if (state.activeWorktreeId) {
      return getResolvedExecutionHostIdForWorktree(state, state.activeWorktreeId)
    }
    // Why: with no workspace the pane opens where it did before host selection, the Active Server.
    const activeServer = settings.activeRuntimeEnvironmentId?.trim()
    return activeServer ? toRuntimeExecutionHostId(activeServer) : LOCAL_EXECUTION_HOST_ID
  })
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const [selected, setSelected] = useState<ExecutionHostId | null>(initialHost)
  if (!selected && initialHost) {
    setSelected(initialHost)
  }
  const host = hosts.find(
    (candidate) =>
      candidate.id === selected || (selected && candidate.aliasHostIds?.includes(selected))
  )
  const target = selected ? runtimeTargetForExecutionHostId(host?.id ?? selected) : null
  const environment =
    target?.kind === 'environment'
      ? environments.find((entry) => entry.id === target.environmentId)
      : null
  return (
    <section className="space-y-8">
      <SettingsRow
        label={translate('settings.agents.launchHost', 'Launch settings on')}
        control={
          <Select
            value={host?.id ?? selected ?? ''}
            onValueChange={(value) => {
              const next = hosts.find((candidate) => candidate.id === value)
              if (next) {
                setSelected(next.id)
              }
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={translate('settings.agents.launchHost', 'Launch settings on')}
            >
              <SelectValue>{host?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {hosts.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {target?.kind === 'local' ? (
        <LocalAgentLaunchSettings
          settings={settings}
          updateSettings={updateSettings}
          renderPermissions={renderPermissions}
        />
      ) : target?.kind === 'environment' && environment ? (
        <HostAgentLaunchSettings
          key={`${target.environmentId}:${environment.pairingRevision ?? environment.createdAt}`}
          environmentId={target.environmentId}
          pairingRevision={environment.pairingRevision ?? environment.createdAt}
          hostName={host?.label ?? environment.name}
          renderPermissions={renderPermissions}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {!selected
            ? translate('settings.agents.loadingHost', 'Loading agent settings…')
            : translate(
                'settings.agents.hostUnavailable',
                'Connect this host to edit its agent launch settings.'
              )}
        </p>
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
  const mutate = (mutation: AgentLaunchSettingsMutation): Promise<void> => {
    const write = (tail.current ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const current = useAppStore.getState().settings ?? settings
        const platform = window.api.platform.get().platform
        await updateSettings(agentLaunchSettingsMutationUpdates(current, mutation, platform))
      })
    tail.current = write
    return write
  }
  return (
    <AgentLaunchSettingsCatalog
      settings={projectAgentLaunchSettings(settings)}
      mutate={mutate}
      detectionTarget={LOCAL_DETECTION_TARGET}
      hostName={null}
      renderPermissions={renderPermissions}
      local={{ settings, updateSettings }}
    />
  )
}

const LOCAL_DETECTION_TARGET = { kind: 'local' } as const
