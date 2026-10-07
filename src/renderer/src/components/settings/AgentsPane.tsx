import { useMemo, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { useAppStore } from '@/store'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AgentCacheTimerSection } from './AgentCacheTimerSection'
import { AgentRuntimeSetting } from './AgentRuntimeSetting'
import { CodexTerminalServerIsolationSetting } from './CodexTerminalServerIsolationSetting'
import { buildCodexSessionSourceHomeControl } from './codex-session-source-home-control'
import {
  getAgentGeneratedTabTitlesDescription,
  getAgentGeneratedTabTitlesTitle
} from './agent-generated-tab-title-copy'
import { getAgentStatusHooksDescription, getAgentStatusHooksTitle } from './agent-status-hooks-copy'
import {
  getAgentWorkspaceTrustDescription,
  getAgentWorkspaceTrustTitle
} from './agent-workspace-trust-copy'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  isTuiAgentEnabled,
  normalizeDisabledTuiAgents
} from '../../../../shared/tui-agent-selection'
import { resolveAgentPermissionPosture } from '../../../../shared/tui-agent-permission-args'
import { resolveLocalAgentLaunchTarget } from '../../../../shared/windows-terminal-shell'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import {
  agentHasPermissionMode,
  resolveDefaultAgentPermissionMode,
  YOLO_TUI_AGENT_ENV,
  type AgentPermissionMode
} from '../../../../shared/tui-agent-permissions'
import { AgentPermissionsSetting } from './AgentPermissionControls'
import {
  buildAgentPermissionExceptions,
  type AgentPermissionRevealTarget
} from './agent-permission-exceptions'
import { getSettingOwnershipSummary } from './setting-ownership'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { getAgentsPaneSearchEntries } from './agents-search'
import {
  buildAgentAvailabilitySettingsUpdate,
  createAgentAvailabilityUpdateQueue
} from './agent-availability-settings'
import { AgentAvailabilityControl, type AgentCatalogRowProps } from './AgentCatalogRow'
import { AgentDefaultSetting } from './AgentDefaultSetting'
import { AgentDetectionCatalog } from './AgentDetectionCatalog'

export {
  AgentPermissionsSetting,
  buildAgentAvailabilitySettingsUpdate,
  createAgentAvailabilityUpdateQueue,
  getAgentsPaneSearchEntries,
  AgentAvailabilityControl
}

type AgentsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
}

const enqueueAgentAvailabilityUpdate = createAgentAvailabilityUpdateQueue()

export function AgentsPane({
  settings,
  updateSettings,
  wslSupportedPlatform,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading
}: AgentsPaneProps): React.JSX.Element {
  const activeServerEnvironmentId = settings.activeRuntimeEnvironmentId?.trim() || null
  const agentDetectionTarget = useMemo<AgentDetectionTarget>(
    () =>
      activeServerEnvironmentId
        ? { kind: 'runtime', environmentId: activeServerEnvironmentId }
        : { kind: 'local' },
    [activeServerEnvironmentId]
  )
  const {
    detectedIds: detectedList,
    detectionFailed,
    isRefreshing,
    refresh: refreshTargetAgents
  } = useDetectedAgents(agentDetectionTarget)
  const refreshLocalAgents = useAppStore((state) => state.refreshDetectedAgents)
  const activeServerName = useAppStore((state) =>
    activeServerEnvironmentId
      ? (state.runtimeEnvironments.find(
          (environment) => environment.id === activeServerEnvironmentId
        )?.name ?? null)
      : null
  )
  const detectedIds = useMemo<Set<string> | null>(
    () => (detectedList ? new Set(detectedList) : null),
    [detectedList]
  )
  const catalog = getAgentCatalog()
  const defaultAgent = settings.defaultTuiAgent
  const cmdOverrides = settings.agentCmdOverrides ?? {}
  const agentDefaultArgs = settings.agentDefaultArgs ?? {}
  const agentDefaultEnv = settings.agentDefaultEnv ?? {}
  const permissionOverrides = settings.agentPermissionModeOverrides ?? {}
  const defaultPermissionMode = resolveDefaultAgentPermissionMode(settings)
  const { agentDefaultEnv: launchEnv, agentPermissionMode, terminalWindowsShell } = settings
  const permissionPostures = useMemo(() => {
    const profile = {
      agentDefaultArgs: settings.agentDefaultArgs,
      agentDefaultEnv: launchEnv,
      agentPermissionMode,
      agentPermissionModeOverrides: settings.agentPermissionModeOverrides
    }
    // Why a local launch: the card reads Arguments as this machine's own launches read them.
    const target = resolveLocalAgentLaunchTarget(getRendererAppPlatform(), terminalWindowsShell)
    return new Map(
      getAgentCatalog()
        .filter((agent) => agentHasPermissionMode(agent.id))
        .map((agent) => [agent.id, resolveAgentPermissionPosture(agent.id, profile, target)])
    )
  }, [
    settings.agentDefaultArgs,
    launchEnv,
    agentPermissionMode,
    settings.agentPermissionModeOverrides,
    terminalWindowsShell
  ])
  const disabledAgents = normalizeDisabledTuiAgents(settings.disabledTuiAgents)
  const detectedAgents =
    detectedIds === null ? [] : catalog.filter((agent) => detectedIds.has(agent.id))
  const [permissionReveal, setPermissionReveal] = useState<{
    agentId: TuiAgent
    target: AgentPermissionRevealTarget
    nonce: number
  } | null>(null)
  const permissionExceptions = buildAgentPermissionExceptions({
    catalog,
    postures: permissionPostures,
    overrides: permissionOverrides,
    defaultMode: defaultPermissionMode,
    detectedIds
  })
  const enabledDetectedAgents = detectedAgents.filter((agent) =>
    isTuiAgentEnabled(agent.id, disabledAgents)
  )
  const undetectedAgents = catalog.filter(
    (agent) => detectedIds !== null && !detectedIds.has(agent.id)
  )

  const setAgentEnabled = (id: TuiAgent, enabled: boolean): void => {
    void enqueueAgentAvailabilityUpdate({
      getSettings: () => useAppStore.getState().settings,
      fallbackSettings: settings,
      updateSettings,
      agentId: id,
      enabled
    })
  }
  const permissionRowProps = (id: TuiAgent): AgentCatalogRowProps['permission'] => {
    const posture = permissionPostures.get(id)
    return posture
      ? {
          // A stored choice this build doesn't know reads as Manual, like everywhere else.
          override: permissionOverrides[id] === undefined ? undefined : posture.mode,
          defaultMode: defaultPermissionMode,
          decidedBy:
            posture.typedArgumentOptions.length > 0
              ? 'arguments'
              : posture.typedEnvironmentOptions.length > 0
                ? 'environment'
                : null,
          onChange: (choice) => {
            const next = { ...permissionOverrides }
            if (choice === 'default') {
              delete next[id]
            } else {
              next[id] = choice
            }
            updateSettings({ agentPermissionModeOverrides: next })
          }
        }
      : undefined
  }
  const getRowProps = (
    agent: (typeof catalog)[number],
    isDetected: boolean
  ): AgentCatalogRowProps => ({
    agentId: agent.id,
    label: agent.label,
    homepageUrl: agent.homepageUrl,
    defaultCmd: agent.cmd,
    defaultArgs: '',
    defaultEnv: {},
    isDetected,
    isEnabled: isTuiAgentEnabled(agent.id, disabledAgents),
    isDefault: isDetected && defaultAgent === agent.id,
    cmdOverride: isDetected ? cmdOverrides[agent.id] : undefined,
    argsOverride: agentDefaultArgs[agent.id] ?? '',
    envOverride: { ...agentDefaultEnv[agent.id] },
    envEditable: agent.id in YOLO_TUI_AGENT_ENV,
    permission: permissionRowProps(agent.id),
    reveal: permissionReveal?.agentId === agent.id ? permissionReveal : undefined,
    onSetDefault: isDetected ? () => updateSettings({ defaultTuiAgent: agent.id }) : () => {},
    onSetEnabled: (enabled) => setAgentEnabled(agent.id, enabled),
    onSaveOverride: isDetected
      ? (value) => {
          const next = { ...cmdOverrides }
          if (value) {
            next[agent.id] = value
          } else {
            delete next[agent.id]
          }
          updateSettings({ agentCmdOverrides: next })
        }
      : () => {},
    onSaveArgs: (value) =>
      updateSettings({ agentDefaultArgs: { ...agentDefaultArgs, [agent.id]: value } }),
    onSaveEnv: (value) =>
      updateSettings({ agentDefaultEnv: { ...agentDefaultEnv, [agent.id]: value } }),
    sessionSourceHome:
      isDetected && agent.id === 'codex'
        ? buildCodexSessionSourceHomeControl(settings, updateSettings)
        : undefined
  })

  return (
    <div className="space-y-8">
      <AgentDefaultSetting
        defaultAgent={defaultAgent}
        detectedIds={detectedIds}
        enabledDetectedAgents={enabledDetectedAgents}
        catalog={catalog}
        description={getSettingOwnershipSummary('agentLaunchDefaults').description}
        onSetDefault={(agent) => updateSettings({ defaultTuiAgent: agent })}
      />
      <AgentRuntimeSetting
        settings={settings}
        updateSettings={updateSettings}
        refresh={refreshLocalAgents}
        wslSupportedPlatform={wslSupportedPlatform}
        wslAvailable={wslAvailable}
        wslDistros={wslDistros}
        wslCapabilitiesLoading={wslCapabilitiesLoading}
      />
      <AgentStatusHooksSetting settings={settings} updateSettings={updateSettings} />
      {!isPairedWebClientWindow() ? (
        <>
          <AgentWorkspaceTrustSetting settings={settings} updateSettings={updateSettings} />
          <CodexTerminalServerIsolationSetting
            settings={settings}
            updateSettings={updateSettings}
          />
        </>
      ) : null}
      <AgentGeneratedTabTitlesSetting settings={settings} updateSettings={updateSettings} />
      {!isPairedWebClientWindow() ? (
        <AgentAwakeSetting settings={settings} updateSettings={updateSettings} />
      ) : null}
      <AgentCacheTimerSection settings={settings} updateSettings={updateSettings} />
      <AgentPermissionsSetting
        mode={defaultPermissionMode}
        exceptions={permissionExceptions}
        onRevealException={({ agentId, target }) => {
          if (target) {
            setPermissionReveal((previous) => ({
              agentId,
              target,
              nonce: (previous?.nonce ?? 0) + 1
            }))
          }
        }}
        onChange={(mode: AgentPermissionMode) => {
          // Only the shared default; each agent's own choice stays until its card says Default.
          if (mode !== defaultPermissionMode) {
            updateSettings({ agentPermissionMode: mode })
          }
        }}
      />
      <AgentDetectionCatalog
        detectedAgents={detectedAgents}
        undetectedAgents={undetectedAgents}
        detectionPending={detectedIds === null}
        detectionFailed={detectionFailed}
        isRefreshing={isRefreshing}
        activeServerEnvironmentId={activeServerEnvironmentId}
        activeServerName={activeServerName}
        onRefresh={() => void refreshTargetAgents()}
        getRowProps={getRowProps}
      />
    </div>
  )
}

export function AgentStatusHooksSetting({ settings, updateSettings }: AgentsPaneProps) {
  const enabled = settings.agentStatusHooksEnabled !== false
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getAgentStatusHooksTitle()}
        description={getAgentStatusHooksDescription()}
        checked={enabled}
        onChange={() => updateSettings({ agentStatusHooksEnabled: !enabled })}
        ariaLabel={getAgentStatusHooksTitle()}
      />
    </section>
  )
}

export function AgentWorkspaceTrustSetting({ settings, updateSettings }: AgentsPaneProps) {
  const enabled = settings.agentWorkspaceTrustEnabled !== false
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getAgentWorkspaceTrustTitle()}
        description={getAgentWorkspaceTrustDescription()}
        checked={enabled}
        onChange={() => updateSettings({ agentWorkspaceTrustEnabled: !enabled })}
        ariaLabel={getAgentWorkspaceTrustTitle()}
      />
    </section>
  )
}

export function AgentGeneratedTabTitlesSetting({ settings, updateSettings }: AgentsPaneProps) {
  const enabled = settings.tabAutoGenerateTitle === true
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getAgentGeneratedTabTitlesTitle()}
        description={getAgentGeneratedTabTitlesDescription()}
        checked={enabled}
        onChange={() => updateSettings({ tabAutoGenerateTitle: !enabled })}
        ariaLabel={getAgentGeneratedTabTitlesTitle()}
      />
    </section>
  )
}
