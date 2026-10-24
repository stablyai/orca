import {
  agentChatPermissionModes,
  savedChatPermissionMode
} from '../../../../shared/agent-chat-permission-mode'
import { useChatProgramFacts } from '@/lib/host-chat-program-acquisition'
import { useMemo } from 'react'
import { toast } from 'sonner'
import type {
  AgentLaunchSettings,
  AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AUTO_TUI_AGENT_ARGS } from '../../../../shared/tui-agent-permissions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  agentPermissionArgs,
  agentPermissionEnv,
  agentPermissionChoices,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission,
  type AgentPermissionChoice,
  type AgentPermissionSettings
} from '../../../../shared/tui-agent-permission-choice'
import {
  agentArgsSetPermission,
  liftAgentPermissionArgs
} from '../../../../shared/tui-agent-permission-lift'
import {
  agentPermissionChoiceLabel,
  AllAgentsPermissionSetting,
  type AgentPermissionChoiceRow
} from './AgentPermissionChoiceControls'
import type { AgentPermissionsSettingProps } from './AgentPermissionsSetting'
import { buildAgentRowPermissions } from './agent-row-permission-model'
import {
  getTuiAgentDefaultArgs,
  getTuiAgentDefaultEnv,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { agentChoiceOpensAsChat } from '@/lib/host-chat-program'
import { useAppStore } from '@/store'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { AgentDefaultSetting } from './AgentDefaultSetting'
import { AgentDetectionCatalog } from './AgentDetectionCatalog'
import type { AgentCatalogRowProps } from './AgentCatalogRow'
import { HostAgentEnvironmentEditor } from './HostAgentEnvironmentEditor'
import { buildCodexSessionSourceHomeControl } from './codex-session-source-home-control'
import { buildDefaultAgentOpensAs } from './native-chat-provider-choice'
import { useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { readNativeDetectedAgents } from '@/store/slices/local-detected-agent-store-state'
import { translate } from '@/i18n/i18n'

export type AgentPermissionsRenderer = (props: AgentPermissionsSettingProps) => React.ReactNode

export function AgentLaunchSettingsCatalog({
  settings,
  mutate,
  detectionTarget,
  hostName,
  renderPermissions,
  refreshSettings,
  autoSupported = true,
  nativeChatPermissionsSupported = false,
  local
}: {
  settings: AgentLaunchSettings
  mutate: (mutation: AgentLaunchSettingsMutation) => Promise<void>
  detectionTarget: AgentDetectionTarget
  hostName: string | null
  renderPermissions: AgentPermissionsRenderer
  refreshSettings?: () => void
  autoSupported?: boolean
  nativeChatPermissionsSupported?: boolean
  local?: {
    settings: GlobalSettings
    saveEnvironment: (agent: TuiAgent, value: Record<string, string>) => Promise<void>
    updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  }
}): React.JSX.Element {
  const {
    detectedIds: detected,
    detectionFailed,
    isRefreshing,
    refresh
  } = useDetectedAgents(detectionTarget)
  const detectedIds = useMemo(() => (detected ? new Set(detected) : null), [detected])
  useHostStructuredAgentsVersion()
  const installedHere = useAppStore(readNativeDetectedAgents)
  const workspace =
    detectionTarget.kind === 'runtime'
      ? { kind: 'git-worktree' as const, runtimeEnvironmentId: detectionTarget.environmentId }
      : { kind: 'floating' as const }
  useChatProgramFacts(workspace, detectionTarget.kind !== 'ssh')
  const chosen = settings.defaultTuiAgent
  // The saved default reads as available where it opens as a chat without its CLI.
  const defaultOpensAsChat = useAppStore((state) =>
    chosen && chosen !== 'blank' && detectionTarget.kind !== 'ssh'
      ? agentChoiceOpensAsChat(state, chosen, workspace, detected)
      : false
  )
  const catalog = getAgentCatalog()
  const detectedAgents =
    detectedIds === null ? [] : catalog.filter((agent) => detectedIds.has(agent.id))
  const undetectedAgents = catalog.filter(
    (agent) => detectedIds !== null && !detectedIds.has(agent.id)
  )
  const save = (mutation: AgentLaunchSettingsMutation): void => {
    const scopedMutation =
      mutation.type === 'permissions' && nativeChatPermissionsSupported
        ? { ...mutation, syncNativeChat: true as const }
        : mutation
    void mutate(scopedMutation).catch(() => {})
  }
  const typed = settings.agentPermission
  const permissionSettings: AgentPermissionSettings | null = typed
    ? { agentPermissionDefault: typed.default, agentPermissionOverrides: typed.overrides }
    : null
  const choiceRow = (agent: TuiAgent): AgentPermissionChoiceRow | undefined => {
    const choices = agentPermissionChoices(agent)
    if (!permissionSettings || choices.length < 2) {
      return undefined
    }
    const resolved = resolveAgentPermission(agent, permissionSettings)
    const chatSupport = agentChatPermissionModes(agent)
    return {
      choices,
      ...resolved,
      terminalChoice:
        agentPermissionArgs(agent, resolved.choice) ||
        Object.keys(agentPermissionEnv(agent, resolved.choice)).length
          ? resolved.choice
          : 'own',
      chatChoice:
        chatSupport && resolved.choice !== 'own'
          ? savedChatPermissionMode(chatSupport, resolved.choice)
          : null,
      defaultChoice: resolveAgentPermission(agent, {
        agentPermissionDefault: permissionSettings.agentPermissionDefault
      }).choice,
      onSelect: (choice) => save({ type: 'permission', agent, choice }),
      flag: agentPermissionArgs(agent, resolved.choice),
      argsSetPermission: agentArgsSetPermission(agent, typed?.userArgs[agent])
    }
  }
  const saveUserArgs = async (agent: TuiAgent, label: string, value: string): Promise<void> => {
    const lifted = liftAgentPermissionArgs(agent, value)
    await mutate({ type: 'user-arguments', agent, value })
    if (lifted.choice) {
      const chatSupported = nativeChatPermissionsSupported && agentChatPermissionModes(agent)
      const values = { agent: label, mode: agentPermissionChoiceLabel(lifted.choice, label) }
      toast.success(
        chatSupported
          ? translate(
              'settings.agents.permissionFromArgs',
              '{{agent}} set to {{mode}} in terminals and new chats.',
              values
            )
          : translate(
              'settings.agents.permissionFromArgsTerminals',
              '{{agent}} set to {{mode}} in terminals.',
              values
            )
      )
    }
  }
  const permissions = buildAgentRowPermissions({
    agents: catalog.map((agent) => agent.id),
    settings,
    localEnv: local ? (local.settings.agentDefaultEnv ?? {}) : null,
    autoSupported,
    save
  })
  const rowProps = (
    agent: (typeof catalog)[number],
    isDetected: boolean
  ): AgentCatalogRowProps => ({
    agentId: agent.id,
    label: agent.label,
    homepageUrl: agent.homepageUrl,
    defaultCmd: agent.cmd,
    defaultArgs: typed ? '' : getTuiAgentDefaultArgs(agent.id),
    defaultEnv: typed ? {} : getTuiAgentDefaultEnv(agent.id),
    hasDefaultEnv: Object.keys(getTuiAgentDefaultEnv(agent.id)).length > 0,
    isDetected,
    isEnabled: isTuiAgentEnabled(agent.id, settings.disabledTuiAgents),
    isDefault: isDetected && settings.defaultTuiAgent === agent.id,
    cmdOverride: isDetected ? settings.agentCmdOverrides[agent.id] : undefined,
    argsOverride: typed
      ? (typed.userArgs[agent.id] ?? '')
      : resolveTuiAgentLaunchArgs(agent.id, settings),
    launchArgs: typed ? (settings.agentDefaultArgs[agent.id] ?? '') : undefined,
    envOverride: !local
      ? {}
      : typed
        ? resolveTuiAgentLaunchEnv(agent.id, local.settings, window.api.platform.get().platform)
        : resolveTuiAgentLaunchEnv(agent.id, { agentDefaultEnv: local.settings.agentDefaultEnv }),
    permission: typed ? undefined : permissions.rows.get(agent.id),
    permissionChoice: choiceRow(agent.id),
    onSetDefault: () =>
      save({
        type: 'default',
        agent: settings.defaultTuiAgent === agent.id ? 'blank' : agent.id
      }),
    onSetEnabled: (enabled) => save({ type: 'availability', agent: agent.id, enabled }),
    onSaveOverride: (value) => mutate({ type: 'command', agent: agent.id, value }),
    onSaveArgs: (value) =>
      typed
        ? saveUserArgs(agent.id, agent.label, value)
        : mutate({ type: 'arguments', agent: agent.id, value }),
    onSaveEnv: (value) => local?.saveEnvironment(agent.id, value),
    ...(!local
      ? {
          environmentNames: settings.environmentNames[agent.id] ?? [],
          environmentEditor: (
            <HostAgentEnvironmentEditor
              agent={agent.id}
              names={settings.environmentNames[agent.id] ?? []}
              mutate={mutate}
            />
          )
        }
      : {}),
    sessionSourceHome:
      local && isDetected && agent.id === 'codex'
        ? buildCodexSessionSourceHomeControl(local.settings, local.updateSettings)
        : undefined
  })
  return (
    <>
      <AgentDefaultSetting
        defaultAgent={settings.defaultTuiAgent}
        detectedIds={detectedIds}
        enabledDetectedAgents={detectedAgents.filter((agent) =>
          isTuiAgentEnabled(agent.id, settings.disabledTuiAgents)
        )}
        catalog={catalog}
        description={translate(
          'settings.agents.hostDefaults',
          'Defaults for new agents on the selected host.'
        )}
        // The chat-or-CLI choice is this computer's, so a paired host's page doesn't offer it.
        opensAs={
          local
            ? buildDefaultAgentOpensAs({
                defaultAgent: settings.defaultTuiAgent,
                settings: local.settings,
                updateSettings: local.updateSettings,
                installedHere
              })
            : undefined
        }
        onSetDefault={(agent) => save({ type: 'default', agent })}
        defaultOpensAsChat={defaultOpensAsChat}
      />
      {permissionSettings ? (
        <AllAgentsPermissionSetting
          choice={permissionSettings.agentPermissionDefault ?? 'own'}
          withoutAutoChoice={sharedChoice(
            PERMISSION_CHOICE_AGENTS.filter(
              (agent) => !agentPermissionChoices(agent).includes('auto')
            ).map((agent) => resolveAgentPermission(agent, permissionSettings).choice)
          )}
          onChange={(choice) => save({ type: 'permission', choice })}
          onChangeWithoutAuto={(choice) => save({ type: 'permission', choice, withoutAuto: true })}
        />
      ) : null}
      {permissionSettings
        ? null
        : renderPermissions({
            mode: permissions.globalMode,
            nonAutoMode: settings.nonAutoPermissionMode,
            majorityMode: permissions.majorityMode,
            autoAgentLabels: catalog
              .filter((agent) => agent.id in AUTO_TUI_AGENT_ARGS)
              .map((agent) => agent.label),
            onChange: (mode) => save({ type: 'permissions', mode }),
            onChangeNonAuto: (mode) => save({ type: 'permissions', mode, exceptAuto: true }),
            autoSupported
          })}
      <AgentDetectionCatalog
        detectedAgents={detectedAgents}
        undetectedAgents={undetectedAgents}
        detectionPending={detectedIds === null}
        detectionFailed={detectionFailed}
        isRefreshing={isRefreshing}
        activeServerEnvironmentId={
          detectionTarget.kind === 'runtime' ? detectionTarget.environmentId : null
        }
        activeServerName={hostName}
        onRefresh={() => {
          void refresh()
          refreshSettings?.()
        }}
        getRowProps={rowProps}
      />
    </>
  )
}

function sharedChoice(choices: readonly AgentPermissionChoice[]): AgentPermissionChoice | null {
  return choices.length > 0 && choices.every((choice) => choice === choices[0]) ? choices[0] : null
}

export function AgentLaunchSettingsLoading(): React.JSX.Element {
  return (
    <fieldset disabled className="min-w-0 space-y-8">
      <AgentDefaultSetting
        defaultAgent="blank"
        detectedIds={null}
        enabledDetectedAgents={[]}
        catalog={[]}
        description={translate(
          'settings.agents.hostDefaults',
          'Defaults for new agents on the selected host.'
        )}
        onSetDefault={() => {}}
      />
      <AllAgentsPermissionSetting
        choice={null}
        withoutAutoChoice={null}
        onChange={() => {}}
        onChangeWithoutAuto={() => {}}
      />
    </fieldset>
  )
}
