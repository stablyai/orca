import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import {
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_NAME,
  ORCA_CLI_SKILL_UPDATE_COMMAND
} from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  isOrcaCliAvailableOnPath,
  isOrcaCliRegistrationRequired
} from '@/lib/agent-skill-cli-prerequisite'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { BROWSER_FAMILY_LABELS } from '../../../../shared/constants'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { getBrowserUsePaneSearchEntries } from './browser-use-search'
import { BrowserUseExamples } from './BrowserUseExamples'
import { BrowserUseComputerUseNotice } from './BrowserUseComputerUseNotice'
import { BrowserUseEnableSwitch } from './BrowserUseEnableSwitch'
import { BrowserUseSkillStep } from './BrowserUseSkillStep'
import { BrowserUseCliStep } from './BrowserUseCliStep'
import { BrowserUseCookieImportStep } from './BrowserUseCookieImportStep'
import {
  buildSkillCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getWslCliDistroRequest
} from './CliSkillRuntimeSetup'
import { translate } from '@/i18n/i18n'

type BrowserUseSetupProps = {
  onConfigureMoreBrowsers?: () => void
  onOpenComputerUse?: () => void
}

export function BrowserUseSetup({
  onConfigureMoreBrowsers,
  onOpenComputerUse
}: BrowserUseSetupProps = {}): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const fetchBrowserSessionProfiles = useAppStore((s) => s.fetchBrowserSessionProfiles)
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)

  const [cliStatus, setCliStatus] = useState<CliInstallStatus | null>(null)
  const [cliLoading, setCliLoading] = useState(true)
  const [cliBusy, setCliBusy] = useState(false)
  const mountedRef = useMountedRef()
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const agentRuntime = activeSkillRuntime.installDisabledReason
    ? undefined
    : activeSkillRuntime.agentRuntime
  const cliRequired = isOrcaCliRegistrationRequired(agentRuntime)
  const browserUseInstallCommand = !activeSkillRuntime.installDisabledReason
    ? buildSkillCommandForRuntime(ORCA_CLI_SKILL_INSTALL_COMMAND, activeSkillRuntime.agentRuntime)
    : ORCA_CLI_SKILL_INSTALL_COMMAND
  const browserUseUpdateCommand = !activeSkillRuntime.installDisabledReason
    ? buildSkillCommandForRuntime(ORCA_CLI_SKILL_UPDATE_COMMAND, activeSkillRuntime.agentRuntime)
    : ORCA_CLI_SKILL_UPDATE_COMMAND

  const handleCliStatusChange = useCallback(
    (nextStatus: CliInstallStatus | null): void => {
      if (mountedRef.current) {
        setCliStatus(nextStatus)
      }
    },
    [mountedRef]
  )

  const [browserUseEnabled, setBrowserUseEnabled] = useState<boolean>(() => {
    return localStorage.getItem(BROWSER_USE_ENABLED_STORAGE_KEY) === '1'
  })

  const toggleBrowserUse = (value: boolean): void => {
    setBrowserUseEnabled(value)
    localStorage.setItem(BROWSER_USE_ENABLED_STORAGE_KEY, value ? '1' : '0')
    if (value) {
      useAppStore.getState().recordFeatureInteraction('agent-browser-setup')
    }
  }

  const refreshCli = useCallback(async (): Promise<void> => {
    if (!cliRequired) {
      handleCliStatusChange(null)
      setCliLoading(false)
      return
    }
    setCliLoading(true)
    try {
      handleCliStatusChange(
        await window.api.cli.getWslInstallStatus(getWslCliDistroRequest(agentRuntime))
      )
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.BrowserUsePane.180a9abf3a',
                'Failed to load CLI status.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setCliLoading(false)
      }
    }
  }, [agentRuntime, cliRequired, handleCliStatusChange, mountedRef])

  useEffect(() => {
    if (!browserUseEnabled) {
      return
    }
    void refreshCli()
    void fetchBrowserSessionProfiles()
  }, [browserUseEnabled, fetchBrowserSessionProfiles, refreshCli])

  const defaultProfile = browserSessionProfiles.find((p) => p.id === 'default')
  const cookiesImported = !!defaultProfile?.source

  const cliPathNeedsAttention =
    cliStatus?.state === 'installed' && cliStatus.pathConfigured === false
  const cliSupported = cliStatus?.supported ?? false

  const {
    installed: skillDetected,
    loading: skillLoading,
    error: skillError,
    refresh: refreshSkill
  } = useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
    enabled: browserUseEnabled,
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  const handleEnableCli = async (): Promise<void> => {
    setCliBusy(true)
    try {
      const next = await ensureWslCliAvailableForAgentSkillTerminal(agentRuntime)
      handleCliStatusChange(next)
      if (mountedRef.current && isOrcaCliAvailableOnPath(next)) {
        toast.success(
          translate(
            'auto.components.settings.BrowserUsePane.721aee31b4',
            'Registered the Orca CLI in PATH.'
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setCliBusy(false)
      }
    }
  }

  const isImportingDefault =
    browserSessionImportState?.profileId === 'default' &&
    browserSessionImportState.status === 'importing'

  const showStep1 = matchesSettingsSearch(searchQuery, [getBrowserUsePaneSearchEntries()[0]])
  const showStep2 = matchesSettingsSearch(searchQuery, [getBrowserUsePaneSearchEntries()[1]])
  const showStep3 = matchesSettingsSearch(searchQuery, [getBrowserUsePaneSearchEntries()[2]])
  // Why: only WSL needs the CLI registered; host terminals already have it on PATH.
  const cliReady = !cliRequired || isOrcaCliAvailableOnPath(cliStatus)
  const steps = cliRequired
    ? [cliReady, skillDetected, cookiesImported]
    : [skillDetected, cookiesImported]
  const completedCount = steps.filter(Boolean).length
  const skillStepIndex = cliRequired ? 2 : 1
  const step2Blocked =
    Boolean(activeSkillRuntime.installDisabledReason) || (!cliReady && !skillDetected)
  const step3Blocked = !cookiesImported && (!cliReady || !skillDetected)

  const sourceLabel = defaultProfile?.source
    ? `${BROWSER_FAMILY_LABELS[defaultProfile.source.browserFamily] ?? defaultProfile.source.browserFamily}${defaultProfile.source.profileName ? ` (${defaultProfile.source.profileName})` : ''}`
    : null

  if (!browserUseEnabled) {
    return (
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {translate('auto.components.settings.BrowserUsePane.b8a1f2d84d', 'Agent Browser Use')}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.BrowserUsePane.96b91c6349',
              'Let coding agents drive this browser with your logins.'
            )}
          </p>
        </div>
        <BrowserUseEnableSwitch
          enabled={browserUseEnabled}
          onToggle={() => toggleBrowserUse(!browserUseEnabled)}
        />
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-2xl border border-border/60 bg-card/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold">
            {translate('auto.components.settings.BrowserUsePane.b8a1f2d84d', 'Agent Browser Use')}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.BrowserUsePane.finishSteps',
              'Let coding agents drive this browser with your logins. Finish the steps below.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              completedCount === steps.length
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {completedCount}/{steps.length}
          </span>
          <BrowserUseEnableSwitch
            enabled={browserUseEnabled}
            onToggle={() => toggleBrowserUse(!browserUseEnabled)}
          />
        </div>
      </div>

      {onOpenComputerUse ? (
        <BrowserUseComputerUseNotice onOpenComputerUse={onOpenComputerUse} />
      ) : null}

      {showStep1 && cliRequired ? (
        <BrowserUseCliStep
          cliStatus={cliStatus}
          cliEnabled={cliReady}
          cliLoading={cliLoading}
          cliBusy={cliBusy}
          cliSupported={cliSupported}
          cliPathNeedsAttention={cliPathNeedsAttention}
          onEnableCli={() => void handleEnableCli()}
        />
      ) : null}

      {showStep2 ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.BrowserUsePane.2d6ead9ab2',
            'Install Browser Use Skill'
          )}
          description={translate(
            'auto.components.settings.BrowserUsePane.68ea76eb71',
            "Install the Browser Use skill so agents can operate Orca's browser."
          )}
          keywords={getBrowserUsePaneSearchEntries()[1].keywords}
          className={cn(
            'rounded-xl border border-border/60 bg-card/50 p-4',
            step2Blocked && 'opacity-60'
          )}
        >
          <BrowserUseSkillStep
            stepIndex={skillStepIndex}
            command={browserUseInstallCommand}
            installedCommand={browserUseUpdateCommand}
            skillDetected={skillDetected}
            skillLoading={skillLoading}
            skillError={activeSkillRuntime.installDisabledReason ?? skillError}
            disabled={step2Blocked}
            terminalShellOverride={activeSkillRuntime.terminalShellOverride}
            terminalRuntime={activeSkillRuntime.agentRuntime}
            preInstallNotice={cliRequired ? AGENT_SKILL_CLI_PREREQUISITE_NOTICE : undefined}
            getPrerequisiteStatus={
              cliRequired
                ? () => window.api.cli.getWslInstallStatus(getWslCliDistroRequest(agentRuntime))
                : undefined
            }
            onBeforeOpenTerminal={async () => {
              useAppStore.getState().recordFeatureInteraction('agent-browser-setup')
              if (cliRequired) {
                await ensureWslCliAvailableForAgentSkillTerminal(agentRuntime)
              }
            }}
            onRecheck={refreshSkill}
          />
        </SearchableSetting>
      ) : null}

      {showStep3 ? (
        <BrowserUseCookieImportStep
          stepIndex={skillStepIndex + 1}
          cookiesImported={cookiesImported}
          isImportingDefault={isImportingDefault}
          step3Blocked={step3Blocked}
          sourceLabel={sourceLabel}
          onConfigureMoreBrowsers={onConfigureMoreBrowsers}
        />
      ) : null}

      <BrowserUseExamples />
    </div>
  )
}
