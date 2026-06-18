import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, TicketCheck, X } from 'lucide-react'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { Button } from '@/components/ui/button'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import {
  LINEAR_TICKETS_SKILL_NAME,
  buildAgentFeatureSkillInstallCommand
} from '@/lib/agent-feature-install-commands'
import {
  ensureOrcaCliAvailableForAgentSkillTerminal,
  isOrcaCliAvailableOnPath
} from '@/lib/agent-skill-cli-prerequisite'
import { cn } from '@/lib/utils'
import {
  buildSkillInstallCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getWslCliDistroRequest
} from '../settings/CliSkillRuntimeSetup'
import {
  getLinearAgentSkillSetupInlineRuntimeCopy,
  getLinearAgentSkillSetupMissingLabel,
  getLinearAgentSkillSetupToastDescription,
  getLinearAgentSkillSetupToastTitle
} from './linear-agent-skill-setup-copy'
import {
  dismissLinearAgentSkillSetupReminderToast,
  resetLinearAgentSkillSetupReminderToastForRuntime,
  resetLinearAgentSkillSetupReminderToastState,
  snoozeLinearAgentSkillSetupReminderToast,
  useLinearAgentSkillSetupReminderToast
} from './linear-agent-skill-setup-reminder-toast'
import {
  getCurrentPlatform,
  getLinearPromptAgentRuntime,
  getLinearPromptSetupCheckIdentity,
  getLinearPromptSkillDiscoveryTarget,
  getLinearPromptTerminalShellOverride,
  getLocalDismissStorageKey,
  readLocalDismissed,
  type LinearAgentSkillPromptSettings
} from './linear-agent-skill-runtime'
import { LinearAgentSkillSetupDialog } from './LinearAgentSkillSetupDialog'
import { translate } from '@/i18n/i18n'

export const _linearAgentSkillSetupPromptInternalsForTests = {
  resetSessionReminders(): void {
    resetLinearAgentSkillSetupReminderToastState()
  }
}

type LinearAgentSkillSetupPromptProps = {
  linked: boolean
  remote: boolean
  surface?: 'inline' | 'modal'
  settings?: LinearAgentSkillPromptSettings | null
  projectRuntime?: ProjectExecutionRuntimeResolution
  currentPlatform?: NodeJS.Platform
  className?: string
}

type SetupCheckResult = 'idle' | 'checking' | 'ready'

export function LinearAgentSkillSetupPrompt({
  linked,
  remote,
  surface = 'inline',
  settings,
  projectRuntime,
  currentPlatform = getCurrentPlatform(),
  className
}: LinearAgentSkillSetupPromptProps): React.JSX.Element | null {
  const [cliStatus, setCliStatus] = useState<CliInstallStatus | null>(null)
  const [cliLoading, setCliLoading] = useState(linked)
  const [setupDialogOpen, setSetupDialogOpen] = useState(false)
  const [setupCheckResult, setSetupCheckResult] = useState<SetupCheckResult>('idle')
  const [activeSetupCheckIdentity, setActiveSetupCheckIdentity] = useState<string | null>(null)
  const agentRuntime = useMemo(
    () => getLinearPromptAgentRuntime(settings, currentPlatform, remote, projectRuntime),
    [currentPlatform, projectRuntime, remote, settings]
  )
  const setupCheckIdentity = useMemo(
    () =>
      getLinearPromptSetupCheckIdentity({
        remote,
        runtime: agentRuntime,
        projectRuntime,
        activeRuntimeEnvironmentId: settings?.activeRuntimeEnvironmentId ?? null
      }),
    [agentRuntime, projectRuntime, remote, settings?.activeRuntimeEnvironmentId]
  )
  const currentSetupCheckIdentityRef = useRef(setupCheckIdentity)
  const cliRefreshGenerationRef = useRef(0)
  currentSetupCheckIdentityRef.current = setupCheckIdentity
  const skillDiscoveryTarget = useMemo(
    () => getLinearPromptSkillDiscoveryTarget(agentRuntime, projectRuntime),
    [agentRuntime, projectRuntime]
  )
  const localDismissStorageKey = getLocalDismissStorageKey(agentRuntime)
  const [localDismissed, setLocalDismissed] = useState(() =>
    readLocalDismissed(localDismissStorageKey)
  )
  const skill = useInstalledAgentSkill(LINEAR_TICKETS_SKILL_NAME, {
    enabled: linked,
    discoveryTarget: skillDiscoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const command = useMemo(
    () =>
      buildSkillInstallCommandForRuntime(
        buildAgentFeatureSkillInstallCommand([LINEAR_TICKETS_SKILL_NAME]),
        agentRuntime
      ),
    [agentRuntime]
  )
  const terminalShellOverride = getLinearPromptTerminalShellOverride(
    currentPlatform,
    settings,
    agentRuntime
  )
  useEffect(() => {
    setLocalDismissed(readLocalDismissed(localDismissStorageKey))
  }, [localDismissStorageKey])

  const writeCliStatusIfCurrent = useCallback(
    (requestIdentity: string, requestGeneration: number, write: () => void): void => {
      if (
        requestGeneration === cliRefreshGenerationRef.current &&
        currentSetupCheckIdentityRef.current === requestIdentity
      ) {
        write()
      }
    },
    []
  )

  const writeCliStatusForIdentity = useCallback((requestIdentity: string, write: () => void) => {
    if (currentSetupCheckIdentityRef.current === requestIdentity) {
      write()
    }
  }, [])

  const refreshCliStatus = useCallback(async (): Promise<void> => {
    const requestIdentity = setupCheckIdentity
    const requestGeneration = ++cliRefreshGenerationRef.current
    const writeIfCurrent = (write: () => void): void => {
      writeCliStatusIfCurrent(requestIdentity, requestGeneration, write)
    }
    if (!linked) {
      writeIfCurrent(() => {
        setCliStatus(null)
        setCliLoading(false)
      })
      return
    }
    setCliLoading(true)
    try {
      const nextStatus = await (agentRuntime.runtime === 'wsl'
        ? window.api.cli.getWslInstallStatus(getWslCliDistroRequest(agentRuntime))
        : window.api.cli.getInstallStatus())
      writeIfCurrent(() => setCliStatus(nextStatus))
    } catch {
      writeIfCurrent(() => setCliStatus(null))
    } finally {
      writeIfCurrent(() => setCliLoading(false))
    }
  }, [agentRuntime, linked, setupCheckIdentity, writeCliStatusIfCurrent])

  useEffect(() => {
    void refreshCliStatus()
  }, [refreshCliStatus])

  const cliAvailable = isOrcaCliAvailableOnPath(cliStatus)
  const setupReady = linked && !cliLoading && !skill.loading && cliAvailable && skill.installed
  const missingSetup = linked && !localDismissed && !cliLoading && !skill.loading && !setupReady
  const explicitCheckMatchesContext = activeSetupCheckIdentity === setupCheckIdentity
  const showCheckingModal =
    surface === 'modal' &&
    setupDialogOpen &&
    setupCheckResult === 'checking' &&
    explicitCheckMatchesContext
  const showSuccessModal =
    surface === 'modal' &&
    setupDialogOpen &&
    setupCheckResult === 'ready' &&
    explicitCheckMatchesContext
  const showSetupModal = setupDialogOpen && (missingSetup || showCheckingModal || showSuccessModal)

  useEffect(() => {
    if (setupCheckResult === 'idle') {
      return
    }
    if (!explicitCheckMatchesContext) {
      setSetupCheckResult('idle')
      setActiveSetupCheckIdentity(null)
      return
    }
    // Why: refreshes update CLI and skill state independently, so success is
    // promoted only after the current render observes both ready for this target.
    if (setupCheckResult === 'checking' && setupReady) {
      setSetupCheckResult('ready')
      return
    }
    if (missingSetup) {
      setSetupCheckResult('idle')
    }
  }, [explicitCheckMatchesContext, missingSetup, setupCheckResult, setupReady])
  const dismissPermanently = (): void => {
    localStorage.setItem(localDismissStorageKey, '1')
    setLocalDismissed(true)
    setSetupDialogOpen(false)
    dismissLinearAgentSkillSetupReminderToast(localDismissStorageKey)
  }

  const closeSuccessModal = (): void => {
    setSetupDialogOpen(false)
    resetLinearAgentSkillSetupReminderToastForRuntime(localDismissStorageKey)
  }

  const successDescription = remote
    ? translate(
        'auto.components.sidebar.LinearAgentSkillSetupPrompt.successDescriptionRemote',
        'Host agents can now use linked Linear tickets. Remote agent environments may still need their own setup.'
      )
    : agentRuntime.runtime === 'wsl'
      ? translate(
          'auto.components.sidebar.LinearAgentSkillSetupPrompt.successDescriptionWsl',
          'WSL agents can now use linked Linear tickets from this workspace.'
        )
      : translate(
          'auto.components.sidebar.LinearAgentSkillSetupPrompt.successDescription',
          'Agents can now read and update linked Linear tickets from this workspace.'
        )
  const snoozeForSession = (): void => {
    snoozeLinearAgentSkillSetupReminderToast(localDismissStorageKey)
    setSetupDialogOpen(false)
  }

  const missingLabel = getLinearAgentSkillSetupMissingLabel(cliAvailable, skill.installed)

  const toastTitle = getLinearAgentSkillSetupToastTitle(cliAvailable, skill.installed)

  const toastDescription = getLinearAgentSkillSetupToastDescription(
    cliAvailable,
    skill.installed,
    remote,
    agentRuntime
  )
  const openSetupDialog = useCallback(() => setSetupDialogOpen(true), [])

  useLinearAgentSkillSetupReminderToast({
    localDismissStorageKey,
    missingSetup,
    setupDialogOpen,
    surface,
    toastDescription,
    toastTitle,
    openSetupDialog
  })

  if (surface !== 'modal' && !missingSetup) {
    return null
  }

  if (surface === 'modal' && !showSetupModal) {
    return null
  }

  const setupDialog = (
    <LinearAgentSkillSetupDialog
      open={setupDialogOpen}
      showSuccess={showSuccessModal}
      successDescription={successDescription}
      missingLabel={missingLabel}
      command={command}
      terminalShellOverride={terminalShellOverride}
      installed={skill.installed}
      loading={showCheckingModal || cliLoading || skill.loading}
      error={skill.error}
      getPrerequisiteStatus={
        agentRuntime.runtime === 'wsl'
          ? () => window.api.cli.getWslInstallStatus(getWslCliDistroRequest(agentRuntime))
          : undefined
      }
      onBeforeOpenTerminal={async () => {
        const requestIdentity = setupCheckIdentity
        const writeIfCurrent = (write: () => void): void => {
          writeCliStatusForIdentity(requestIdentity, write)
        }
        const nextStatus =
          agentRuntime.runtime === 'wsl'
            ? await ensureWslCliAvailableForAgentSkillTerminal(agentRuntime)
            : await ensureOrcaCliAvailableForAgentSkillTerminal({
                onStatusChange: (nextCliStatus) => {
                  writeIfCurrent(() => setCliStatus(nextCliStatus))
                }
              })
        if (agentRuntime.runtime === 'wsl') {
          writeIfCurrent(() => setCliStatus(nextStatus))
        }
      }}
      onRecheck={async () => {
        if (surface === 'modal') {
          setActiveSetupCheckIdentity(setupCheckIdentity)
          setSetupCheckResult('checking')
          await Promise.all([refreshCliStatus(), skill.refresh()])
          return
        }
        await refreshCliStatus()
        await skill.refresh()
      }}
      onOpenChange={(open) => {
        if (open) {
          setSetupDialogOpen(true)
          return
        }
        if (showSuccessModal) {
          closeSuccessModal()
          return
        }
        if (surface === 'modal') {
          snoozeForSession()
          return
        }
        setSetupDialogOpen(false)
      }}
      onDismissPermanently={dismissPermanently}
      onSnoozeForSession={snoozeForSession}
      onDone={closeSuccessModal}
    />
  )

  if (surface === 'modal') {
    return setupDialog
  }

  return (
    <div
      className={cn(
        'mt-1.5 rounded-md border border-worktree-sidebar-border bg-worktree-sidebar-accent/35 px-2.5 py-2 text-[11px] text-muted-foreground',
        className
      )}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-start gap-2">
        <TicketCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-medium text-foreground">
            {translate(
              'auto.components.sidebar.LinearAgentSkillSetupPrompt.title',
              'Set up Linear agent skill'
            )}
          </div>
          <p className="leading-snug">
            {missingLabel} {getLinearAgentSkillSetupInlineRuntimeCopy(remote, agentRuntime)}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={translate(
            'auto.components.sidebar.LinearAgentSkillSetupPrompt.dismiss',
            'Dismiss Linear agent skill setup'
          )}
          onClick={dismissPermanently}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button type="button" variant="outline" size="xs" onClick={() => setSetupDialogOpen(true)}>
          {translate('auto.components.sidebar.LinearAgentSkillSetupPrompt.setup', 'Set up')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="gap-1"
          onClick={() => {
            void refreshCliStatus()
            void skill.refresh()
          }}
        >
          <RefreshCw className="size-3" />
          {translate('auto.components.sidebar.LinearAgentSkillSetupPrompt.recheck', 'Re-check')}
        </Button>
      </div>
      {setupDialog}
    </div>
  )
}
