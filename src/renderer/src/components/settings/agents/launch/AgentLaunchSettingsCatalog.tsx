import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { AgentLaunchChoiceEditor } from '@/components/agent/launch-settings/AgentLaunchChoiceEditor'
import { agentChatPermissionModes } from '../../../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import { savedChatPermissionMode } from '../../../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { useChatProgramFacts } from '@/lib/agent-session/launch/inventory/host-chat-program-acquisition'
import { useMemo } from 'react'
import { recomputeOn } from '@/lib/recompute-on'
import { toast } from 'sonner'
import type {
  AgentLaunchSettings,
  AgentLaunchSettingsMutation
} from '../../../../../../shared/agent-launch/choices/agent-launch-settings'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { AUTO_TUI_AGENT_ARGS } from '../../../../../../shared/agent-launch/permissions/tui-agent-permissions'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  agentPermissionArgs,
  agentPermissionEnv,
  agentPermissionChoices,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission,
  type AgentPermissionSettings
} from '../../../../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { agentArgsSetPermission } from '../../../../../../shared/agent-launch/permissions/agent-permission-args'
import { liftAgentPermissionArgs } from '../../../../../../shared/agent-launch/permissions/tui-agent-permission-lift'
import { agentPermissionChoiceLabel } from '../../../agent/launch-settings/agent-permission-choice-label'
import { AllAgentsPermissionSetting } from '../permissions/AllAgentsPermissionSetting'
import type { AgentPermissionChoiceRow } from '../../../agent/launch-settings/agent-permission-choice-row'
import type { AgentPermissionsSettingProps } from '@/components/settings/agents/permissions/AgentPermissionsSetting'
import {
  buildAgentRowPermissions,
  sharedAgentPermissionChoice as sharedChoice
} from '@/components/settings/agents/permissions/agent-row-permission-model'
import {
  getTuiAgentDefaultArgs,
  getTuiAgentDefaultEnv,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../../../shared/agent-launch/choices/tui-agent-launch-defaults'
import {
  isTuiAgentEnabled,
  pickTuiAgent
} from '../../../../../../shared/agent-launch/catalog/tui-agent-selection'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import {
  agentChoiceOpensAsChat,
  readChatProgram,
  resolveChatProgramContext
} from '@/lib/agent-session/launch/inventory/host-chat-program'
import { readNativeDetectedAgents } from '@/store/slices/agent-inventory/local-detected-agent-store-state'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { AgentLaunchDefaultsGroup } from '@/components/settings/agents/launch/AgentLaunchDefaultsGroup'
import { AgentDetectionCatalog } from '@/components/settings/agents/launch/AgentDetectionCatalog'
import type { AgentCatalogRowProps } from '@/components/settings/agents/launch/AgentCatalogRow'
import { HostAgentEnvironmentEditor } from '@/components/settings/agents/launch/HostAgentEnvironmentEditor'
import { buildCodexSessionSourceHomeControl } from '@/components/agent/launch-settings/codex-session-source-home-control'
import { buildAgentOpensAs } from '@/lib/agent-session/launch/native-chat-provider-choice'
import {
  AgentChatRuntimeArea,
  chatUnavailableOnThisDesktop
} from '@/components/agent/launch-settings/AgentChatChoiceControls'
import {
  chatProviderAgents,
  useHostStructuredAgentsVersion
} from '@/runtime/native-chat/agent-catalogs/chat-provider-agents'
import { readHostStructuredAgents } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
  const {
    detectedIds: detected,
    detectionFailed,
    isRefreshing,
    refresh
  } = useDetectedAgents(detectionTarget, 'all')
  const detectedIds = useMemo(() => (detected ? new Set(detected) : null), [detected])
  const hostAgentsVersion = useHostStructuredAgentsVersion()
  const installedHere = useAppStateValue(readNativeDetectedAgents)
  const workspace =
    detectionTarget.kind === 'runtime'
      ? { kind: 'git-worktree' as const, runtimeEnvironmentId: detectionTarget.environmentId }
      : { kind: 'floating' as const }
  useChatProgramFacts(workspace, detectionTarget.kind !== 'ssh')
  const chosen = settings.defaultTuiAgent
  // The saved default reads as available where it opens as a chat without its CLI.
  const defaultOpensAsChat = useAppStateValue((state) =>
    chosen && chosen !== 'blank' && detectionTarget.kind !== 'ssh'
      ? agentChoiceOpensAsChat(state, chosen, workspace, detected)
      : false
  )
  // The chat-or-CLI choice is this computer's, so a paired host's page doesn't offer it.
  const chatAgents = local
    ? recomputeOn([hostAgentsVersion], () => chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined))
    : []
  const managedChatAgents = new Set(
    recomputeOn([hostAgentsVersion], () =>
      readHostStructuredAgents(LOCAL_EXECUTION_HOST_ID, undefined)
    )
      ?.filter((row) => row.managedRuntime)
      .map((row) => row.agent)
  )
  // Agents whose chat program is here without their CLI, like a downloaded chat runtime, are installed for chat.
  const chatOnlyKey = useAppStateValue((state) => {
    if (detectionTarget.kind === 'ssh') {
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
  const installedAgents = catalog.filter(
    (agent) => detectedIds?.has(agent.id) || chatOnly.has(agent.id)
  )
  const undetectedAgents = catalog.filter(
    (agent) =>
      !detectedIds?.has(agent.id) &&
      !chatOnly.has(agent.id) &&
      (detectedIds !== null || chatAgents.includes(agent.id))
  )
  // The agent new sessions get: the saved default when usable, else Auto's pick.
  const effectiveDefault =
    detectedIds === null
      ? null
      : pickTuiAgent(chosen, detectedIds, settings.disabledTuiAgents, (agent) =>
          Boolean(defaultOpensAsChat && agent === chosen)
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
          ? t(
              'settings.agents.permissionFromArgs',
              '{{agent}} set to {{mode}} in terminals and new chats.',
              values
            )
          : t(
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
    defaultMark: effectiveDefault !== agent.id ? null : chosen === agent.id ? 'chosen' : 'auto',
    isSavedDefault: chosen === agent.id,
    cmdOverride: settings.agentCmdOverrides[agent.id],
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
              catalogTarget={
                detectionTarget.kind === 'ssh'
                  ? null
                  : detectionTarget.kind === 'runtime'
                    ? { kind: 'environment', environmentId: detectionTarget.environmentId }
                    : { kind: 'local' }
              }
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
    onSetDefault: (isDefault) => save({ type: 'default', agent: isDefault ? agent.id : null }),
    onSetEnabled: (enabled) => save({ type: 'availability', agent: agent.id, enabled }),
    onSaveOverride: async (value) => {
      const changed = value !== (settings.agentCmdOverrides[agent.id] ?? '')
      await mutate({ type: 'command', agent: agent.id, value })
      // Detection probes the override; local inventories reset on the settings change, a host's need a refresh.
      if (changed && !local) {
        void refresh()
      }
    },
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
            updateSettings: local.updateSettings,
            includeDisabled: true
          })
        : undefined,
      reserveOpensAsSlot: Boolean(local),
      chatRuntime:
        chatAgents.includes(agent.id) &&
        (managedChatAgents.has(agent.id) || chatUnavailableOnThisDesktop(agent.id)) &&
        isTuiAgentEnabled(agent.id, settings.disabledTuiAgents) ? (
          <AgentChatRuntimeArea agent={agent.id} label={agent.label} />
        ) : undefined
    }
  }
  return (
    <>
      <AgentLaunchDefaultsGroup
        description={t(
          'settings.agents.hostDefaults',
          'Defaults for new agents on the selected host.'
        )}
        permissions={
          permissionSettings ? (
            <AllAgentsPermissionSetting
              chatOwnSupported={chatOwnSupported}
              choice={permissionSettings.agentPermissionDefault ?? 'own'}
              withoutAutoChoice={sharedChoice(
                PERMISSION_CHOICE_AGENTS.filter(
                  (agent) => !agentPermissionChoices(agent).includes('auto')
                ).map((agent) => resolveAgentPermission(agent, permissionSettings).choice)
              )}
              onChange={(choice) => save({ type: 'permission', choice })}
              onChangeWithoutAuto={(choice) =>
                save({ type: 'permission', choice, withoutAuto: true })
              }
            />
          ) : (
            renderPermissions({
              mode: permissions.globalMode,
              nonAutoMode: settings.nonAutoPermissionMode,
              majorityMode: permissions.majorityMode,
              autoAgentLabels: catalog
                .filter((agent) => agent.id in AUTO_TUI_AGENT_ARGS)
                .map((agent) => agent.label),
              onChange: (mode) => save({ type: 'permissions', mode }),
              onChangeNonAuto: (mode) => save({ type: 'permissions', mode, exceptAuto: true }),
              autoSupported
            })
          )
        }
      />
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
