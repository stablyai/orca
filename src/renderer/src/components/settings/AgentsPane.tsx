import { useMemo } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { applyAgentPermissionModeViaCatalog } from '@/lib/agent-catalog-authoring'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AgentCacheTimerSection } from './AgentCacheTimerSection'
import { AgentRuntimeSetting } from './AgentRuntimeSetting'
import {
  resolveAgentPermissionModeSummary,
  type AgentPermissionMode
} from '../../../../shared/tui-agent-permissions'
import {
  AgentsPaneReadOnlyNotice,
  guardAgentsPaneWrite,
  resolveAgentsPaneReadOnly
} from './agents-pane-read-only'
import { AgentPermissionsSetting } from './AgentPermissionsSetting'
import { AgentStatusHooksSetting, AgentGeneratedTabTitlesSetting } from './AgentBehaviorToggles'
import { AgentCatalogSection } from './AgentCatalogSection'
import { buildCodexSessionSourceHomeControl } from './codex-session-source-home-control'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { translate } from '@/i18n/i18n'
import { SettingsBadge } from './SettingsFormControls'

export { getAgentsPaneSearchEntries } from './agents-search'
export { AgentPermissionsSetting } from './AgentPermissionsSetting'
export { AgentStatusHooksSetting, AgentGeneratedTabTitlesSetting } from './AgentBehaviorToggles'

type AgentsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
  /** Defaults to a paired web client being read-only; explicit value wins (tests). */
  readOnly?: boolean
}

export function AgentsPane({
  settings,
  updateSettings,
  wslSupportedPlatform,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading,
  readOnly
}: AgentsPaneProps): React.JSX.Element {
  const isReadOnly = resolveAgentsPaneReadOnly(readOnly)
  // Why: a paired web client renders the catalog view-only; the disabled fieldset
  // blocks interaction and these guards stop any write that slips through, while
  // the host rejects remote authoring at the RPC boundary (defense-in-depth).
  const applyUpdate: AgentsPaneProps['updateSettings'] = (updates) =>
    guardAgentsPaneWrite(isReadOnly, () => void updateSettings(updates))
  const activeServerEnvironmentId = settings.activeRuntimeEnvironmentId?.trim() || null
  const detectionTarget = useMemo<AgentDetectionTarget>(
    () =>
      activeServerEnvironmentId
        ? { kind: 'runtime', environmentId: activeServerEnvironmentId }
        : { kind: 'local' },
    [activeServerEnvironmentId]
  )
  const {
    detectedIds,
    detectionFailed,
    isRefreshing,
    refresh: refreshTargetAgents
  } = useDetectedAgents(detectionTarget)
  const refreshLocalAgents = useAppStore((s) => s.refreshDetectedAgents)
  const activeServerName = useAppStore((s) =>
    activeServerEnvironmentId
      ? (s.runtimeEnvironments.find((environment) => environment.id === activeServerEnvironmentId)
          ?.name ?? null)
      : null
  )

  const agentDefaultArgs = settings.agentDefaultArgs ?? {}
  const agentDefaultEnv = settings.agentDefaultEnv ?? {}
  const agentPermissionMode = resolveAgentPermissionModeSummary({
    agentDefaultArgs,
    agentDefaultEnv
  })

  const saveAgentPermissionMode = (mode: Exclude<AgentPermissionMode, 'mixed'>): void => {
    guardAgentsPaneWrite(
      isReadOnly,
      () => void applyAgentPermissionModeViaCatalog(mode, { agentDefaultArgs, agentDefaultEnv })
    )
  }

  return (
    <div className="min-w-0 space-y-8">
      {isReadOnly && <AgentsPaneReadOnlyNotice />}

      {/* Why: the catalog stays outside the disabled fieldset so its search box
          remains usable in read-only mode; the section scopes disabling to its
          own editable controls (default picker, rows, header actions). */}
      <AgentCatalogSection
        agentCmdOverrides={settings.agentCmdOverrides}
        codexSessionSourceHome={buildCodexSessionSourceHomeControl(settings, applyUpdate)}
        detectionTarget={detectionTarget}
        readOnly={isReadOnly}
      />

      {activeServerName && detectedIds !== null ? (
        <SettingsBadge tone="muted">
          {translate('auto.components.settings.AgentsPane.03e1a5081a', 'on {{value0}}', {
            value0: activeServerName
          })}
        </SettingsBadge>
      ) : null}

      {detectedIds === null && !detectionFailed ? (
        <div className="flex items-center justify-center rounded-md border border-dashed border-border/50 py-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.AgentsPane.d83834f5e6',
            'Detecting installed agents…'
          )}
        </div>
      ) : null}

      {detectionFailed ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {translate(
              'auto.components.settings.AgentsPane.remoteDetectionFailed',
              'Couldn’t detect installed agents. Check the host connection and try again.'
            )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void refreshTargetAgents()}
            disabled={isRefreshing}
            className="h-6 shrink-0 gap-1.5 px-2 text-destructive hover:text-destructive"
          >
            <RefreshCw className="size-3" />
            {translate('auto.components.settings.AgentsPane.retryDetection', 'Retry')}
          </Button>
        </div>
      ) : null}

      <fieldset disabled={isReadOnly} className="m-0 min-w-0 space-y-8 border-0 p-0">
        <AgentRuntimeSetting
          settings={settings}
          updateSettings={applyUpdate}
          refresh={refreshLocalAgents}
          wslSupportedPlatform={wslSupportedPlatform}
          wslAvailable={wslAvailable}
          wslDistros={wslDistros}
          wslCapabilitiesLoading={wslCapabilitiesLoading}
        />

        <AgentStatusHooksSetting settings={settings} updateSettings={applyUpdate} />

        <AgentGeneratedTabTitlesSetting settings={settings} updateSettings={applyUpdate} />

        {!isPairedWebClientWindow() ? (
          <AgentAwakeSetting settings={settings} updateSettings={applyUpdate} />
        ) : null}

        <AgentCacheTimerSection settings={settings} updateSettings={applyUpdate} />

        <AgentPermissionsSetting mode={agentPermissionMode} onChange={saveAgentPermissionMode} />
      </fieldset>
    </div>
  )
}
