import { AgentLaunchChoiceEditor } from './AgentLaunchChoiceEditor'
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
import {
  buildAgentRowPermissions,
  sharedAgentPermissionChoice as sharedChoice
} from './agent-row-permission-model'
import {
  getTuiAgentDefaultArgs,
  getTuiAgentDefaultEnv,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  agentChoiceOpensAsChat,
  readChatProgram,
  resolveChatProgramContext
} from '@/lib/host-chat-program'
import { useAppStore } from '@/store'
import { readNativeDetectedAgents } from '@/store/slices/local-detected-agent-store-state'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { AgentDefaultSetting } from './AgentDefaultSetting'
import { AgentDetectionCatalog } from './AgentDetectionCatalog'
import type { AgentCatalogRowProps } from './AgentCatalogRow'
import { HostAgentEnvironmentEditor } from './HostAgentEnvironmentEditor'
import { buildCodexSessionSourceHomeControl } from './codex-session-source-home-control'
import { buildAgentOpensAs } from './native-chat-provider-choice'
import { AgentChatRuntimeArea } from './AgentChatChoiceControls'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { readHostStructuredAgents } from '@/runtime/host-structured-agents'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isNativeChatEnabled } from '../../../../shared/structured-native-chat-launch-route'
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
  choicesSupported = true,
  nativeChatPermissionsSupported = false,
  chatOwnSupported = false,
  local
}: {
  settings: AgentLaunchSettings
  mutate: (mutation: AgentLaunchSettingsMutation) => Promise<void>
  detectionTarget: AgentDetectionTarget
  hostName: string | null
  renderPermissions: AgentPermissionsRenderer
  refreshSettings?: () => void
  autoSupported?: boolean
  choicesSupported?: boolean
  nativeChatPermissionsSupported?: boolean
  chatOwnSupported?: boolean
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
  } = useDetectedAgents(detectionTarget, 'all')
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
  // The chat-or-CLI choice is this computer's, so a paired host's page doesn't offer it.
  const chatAgents =
    local && isNativeChatEnabled(local.settings)
      ? chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined)
      : []
  const managedChatAgents = new Set(
    readHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, undefined)
      ?.filter((row) => row.managedRuntime)
      .map((row) => row.agent)
  )
  // Agents whose chat program is here without their CLI, like a downloaded chat runtime, are installed for chat.
  const chatOnlyKey = useAppStore((state) => {
    if (detectionTarget.kind === 'ssh' || (local && !isNativeChatEnabled(local.settings))) {
      return ''
    }
    const context = resolveChatProgramContext(state, workspace)
    const selectedDetected = detectionTarget.kind === 'runtime' ? detected : installedHere
    return chatProviderAgents(context.executionHostId, state.runtimeStatusByEnvironmentId)
      .filter(
        (agent) =>
          !selectedDetected?.includes(agent) &&
          readChatProgram(state, agent, context, selectedDetected) === 'available'
      )
      .join(' ')
  })
  const chatOnly = new Set(chatOnlyKey.split(' '))
  const catalog = getAgentCatalog()
  const detectedAgents =
    detectedIds === null ? [] : catalog.filter((agent) => detectedIds.has(agent.id))
  const installedAgents = catalog.filter(
    (agent) => detectedIds?.has(agent.id) || chatOnly.has(agent.id)
  )
  const undetectedAgents = catalog.filter(
    (agent) =>
      !detectedIds?.has(agent.id) &&
      !chatOnly.has(agent.id) &&
      (detectedIds !== null || chatAgents.includes(agent.id))
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
      chatOwnSupported,
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
  const cliRowProps = (
    agent: (typeof catalog)[number],
    isDetected: boolean
  ): AgentCatalogRowProps => ({
    agentId: agent.id,
    label: agent.label,
    homepageUrl: agent.homepageUrl,
    defaultCmd: agent.cmd,
    defaultArgs: typed ? '' : getTuiAgentDefaultArgs(agent.id),
    defaultEnv: typed ? {} : getTuiAgentDefaultEnv(agent.id),
    isDetected,
    isEnabled: isTuiAgentEnabled(agent.id, settings.disabledTuiAgents),
    isDefault: isDetected && settings.defaultTuiAgent === agent.id,
    cmdOverride: isDetected ? settings.agentCmdOverrides[agent.id] : undefined,
    argsOverride:
      choicesSupported && settings.agentChoices
        ? (settings.agentChoices.userArgs[agent.id] ?? '')
        : typed
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
    launchChoiceEditor:
      choicesSupported && settings.agentChoices && (isDetected || chatOnly.has(agent.id))
        ? (permissionControlRef) => (
            <AgentLaunchChoiceEditor
              permissionControlRef={permissionControlRef}
              showArguments={isDetected}
              agent={agent.id}
              label={agent.label}
              choices={settings.agentChoices?.defaults[agent.id]}
              userArgs={settings.agentChoices?.userArgs[agent.id] ?? ''}
              permission={choiceRow(agent.id)}
              save={(patch, userArgs) =>
                mutate({ type: 'launch-choices', agent: agent.id, patch, userArgs })
              }
            />
          )
        : undefined,
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
  const rowProps = (
    agent: (typeof catalog)[number],
    listedInstalled: boolean
  ): AgentCatalogRowProps => {
    const isDetected = listedInstalled && detectedIds?.has(agent.id) === true
    return {
      ...cliRowProps(agent, isDetected),
      opensAs: local
        ? buildAgentOpensAs({
            agent: agent.id,
            cliDetected: installedHere === null ? null : installedHere.includes(agent.id),
            chatProgramHere: chatOnly.has(agent.id),
            settings: local.settings,
            updateSettings: local.updateSettings
          })
        : undefined,
      chatRuntime:
        chatAgents.includes(agent.id) &&
        managedChatAgents.has(agent.id) &&
        isTuiAgentEnabled(agent.id, settings.disabledTuiAgents) ? (
          <AgentChatRuntimeArea agent={agent.id} label={agent.label} />
        ) : undefined
    }
  }
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
        onSetDefault={(agent) => save({ type: 'default', agent })}
        defaultOpensAsChat={defaultOpensAsChat}
      />
      {permissionSettings ? (
        <AllAgentsPermissionSetting
          chatOwnSupported={chatOwnSupported}
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
        detectedAgents={installedAgents}
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

export { AgentLaunchSettingsLoading } from './AgentLaunchSettingsLoading'
