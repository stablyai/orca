import { useCallback, useEffect, useMemo, useState } from 'react'
import { Info, RefreshCw, TicketCheck, X } from 'lucide-react'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { SkillDiscoveryTarget } from '../../../../shared/skills'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import {
  LINEAR_TICKETS_SKILL_NAME,
  buildAgentFeatureSkillInstallCommand
} from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal,
  isOrcaCliAvailableOnPath
} from '@/lib/agent-skill-cli-prerequisite'
import { cn } from '@/lib/utils'
import { AgentSkillSetupPanel } from '../settings/AgentSkillSetupPanel'
import {
  buildSkillInstallCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getWslCliDistroRequest
} from '../settings/CliSkillRuntimeSetup'
import {
  getCurrentPlatform,
  getLinearPromptAgentRuntime,
  getLinearPromptTerminalShellOverride,
  getLocalDismissStorageKey,
  readLocalDismissed,
  type LinearAgentSkillPromptSettings
} from './linear-agent-skill-runtime'
import { translate } from '@/i18n/i18n'

// Why: closing the workspace modal means "not now"; keep it quiet for this
// app session without turning a casual close into a permanent dismissal.
const sessionSnoozedRuntimeKeys = new Set<string>()

export const _linearAgentSkillSetupPromptInternalsForTests = {
  resetSessionSnoozes(): void {
    sessionSnoozedRuntimeKeys.clear()
  }
}

type LinearAgentSkillSetupPromptProps = {
  linked: boolean
  remote: boolean
  surface?: 'inline' | 'modal'
  settings?: LinearAgentSkillPromptSettings | null
  currentPlatform?: NodeJS.Platform
  className?: string
}

export function LinearAgentSkillSetupPrompt({
  linked,
  remote,
  surface = 'inline',
  settings,
  currentPlatform = getCurrentPlatform(),
  className
}: LinearAgentSkillSetupPromptProps): React.JSX.Element | null {
  const [cliStatus, setCliStatus] = useState<CliInstallStatus | null>(null)
  const [cliLoading, setCliLoading] = useState(linked)
  const [setupDialogOpen, setSetupDialogOpen] = useState(false)
  const agentRuntime = useMemo(
    () => getLinearPromptAgentRuntime(settings, currentPlatform, remote),
    [currentPlatform, remote, settings]
  )
  const skillDiscoveryTarget = useMemo<SkillDiscoveryTarget | undefined>(
    () =>
      agentRuntime.runtime === 'wsl'
        ? { runtime: 'wsl', wslDistro: agentRuntime.wslDistro }
        : undefined,
    [agentRuntime.runtime, agentRuntime.wslDistro]
  )
  const localDismissStorageKey = getLocalDismissStorageKey(agentRuntime)
  const [localDismissed, setLocalDismissed] = useState(() =>
    readLocalDismissed(localDismissStorageKey)
  )
  const [sessionSnoozed, setSessionSnoozed] = useState(() =>
    sessionSnoozedRuntimeKeys.has(localDismissStorageKey)
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
  const dismissed = localDismissed || sessionSnoozed

  useEffect(() => {
    setLocalDismissed(readLocalDismissed(localDismissStorageKey))
    setSessionSnoozed(sessionSnoozedRuntimeKeys.has(localDismissStorageKey))
  }, [localDismissStorageKey])

  const refreshCliStatus = useCallback(async (): Promise<void> => {
    if (!linked) {
      setCliStatus(null)
      setCliLoading(false)
      return
    }
    setCliLoading(true)
    try {
      setCliStatus(
        await (agentRuntime.runtime === 'wsl'
          ? window.api.cli.getWslInstallStatus(getWslCliDistroRequest(agentRuntime))
          : window.api.cli.getInstallStatus())
      )
    } catch {
      setCliStatus(null)
    } finally {
      setCliLoading(false)
    }
  }, [agentRuntime, linked])

  useEffect(() => {
    void refreshCliStatus()
  }, [refreshCliStatus])

  const cliAvailable = isOrcaCliAvailableOnPath(cliStatus)
  const missingSetup =
    linked && !dismissed && !cliLoading && !skill.loading && !(cliAvailable && skill.installed)

  useEffect(() => {
    if (surface === 'modal' && missingSetup) {
      setSetupDialogOpen(true)
    }
  }, [missingSetup, surface])

  const dismissPermanently = (): void => {
    localStorage.setItem(localDismissStorageKey, '1')
    setLocalDismissed(true)
    setSetupDialogOpen(false)
  }

  const snoozeForSession = (): void => {
    sessionSnoozedRuntimeKeys.add(localDismissStorageKey)
    setSessionSnoozed(true)
    setSetupDialogOpen(false)
  }

  const missingLabel =
    !cliAvailable && !skill.installed
      ? translate(
          'auto.components.sidebar.LinearAgentSkillSetupPrompt.missingCliAndSkill',
          'Orca CLI and Linear agent skill are missing.'
        )
      : !cliAvailable
        ? translate(
            'auto.components.sidebar.LinearAgentSkillSetupPrompt.missingCli',
            'Orca CLI is missing.'
          )
        : translate(
            'auto.components.sidebar.LinearAgentSkillSetupPrompt.missingSkill',
            'Linear agent skill is missing.'
          )

  if (!missingSetup) {
    return null
  }

  const setupDialog = (
    <Dialog
      open={setupDialogOpen}
      onOpenChange={(open) => {
        if (open) {
          setSetupDialogOpen(true)
          return
        }
        if (surface === 'modal') {
          snoozeForSession()
          return
        }
        setSetupDialogOpen(false)
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <div className="px-6 pt-6 pr-14">
          <DialogHeader>
            <DialogTitle className="sr-only">
              {translate(
                'auto.components.sidebar.LinearAgentSkillSetupPrompt.modalTitle',
                'Enable Linear ticket access'
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {translate(
                'auto.components.sidebar.LinearAgentSkillSetupPrompt.modalDescription',
                'Install the Linear skill from a terminal.'
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 text-base font-semibold leading-snug text-foreground">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p>
              {translate(
                'auto.components.sidebar.LinearAgentSkillSetupPrompt.modalPrompt',
                'Enable agents to read and edit the attached Linear ticket.'
              )}
            </p>
          </div>
        </div>
        <AgentSkillSetupPanel
          className="px-6 pt-4 pb-3"
          variant="inline"
          hideHeader
          title={translate(
            'auto.components.sidebar.LinearAgentSkillSetupPrompt.modalTitle',
            'Enable Linear ticket access'
          )}
          description={missingLabel}
          command={command}
          terminalTitle={translate(
            'auto.components.sidebar.LinearAgentSkillSetupPrompt.terminalTitle',
            'Install Linear agent skill'
          )}
          terminalAriaLabel={translate(
            'auto.components.sidebar.LinearAgentSkillSetupPrompt.terminalAria',
            'Linear agent skill installer terminal'
          )}
          terminalWorktreeId="sidebar-linear-agent-skill-setup"
          terminalHeightPx={240}
          terminalShellOverride={terminalShellOverride}
          installed={skill.installed}
          loading={skill.loading}
          error={skill.error}
          installLabel={translate(
            'auto.components.sidebar.LinearAgentSkillSetupPrompt.install',
            'Install CLI & Skill'
          )}
          preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
          getPrerequisiteStatus={
            agentRuntime.runtime === 'wsl'
              ? () => window.api.cli.getWslInstallStatus(getWslCliDistroRequest(agentRuntime))
              : undefined
          }
          isPrerequisiteAvailable={isOrcaCliAvailableOnPath}
          onBeforeOpenTerminal={async () => {
            const nextStatus =
              agentRuntime.runtime === 'wsl'
                ? await ensureWslCliAvailableForAgentSkillTerminal(agentRuntime)
                : await ensureOrcaCliAvailableForAgentSkillTerminal({
                    onStatusChange: setCliStatus
                  })
            if (agentRuntime.runtime === 'wsl') {
              setCliStatus(nextStatus)
            }
          }}
          onRecheck={async () => {
            await refreshCliStatus()
            await skill.refresh()
          }}
        />
        <DialogFooter className="px-6 pb-6">
          <Button type="button" variant="ghost" size="sm" onClick={dismissPermanently}>
            {translate(
              'auto.components.sidebar.LinearAgentSkillSetupPrompt.dontShowAgain',
              "Don't show again"
            )}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={snoozeForSession}>
            {translate('auto.components.sidebar.LinearAgentSkillSetupPrompt.notNow', 'Not now')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
            {missingLabel}{' '}
            {remote
              ? translate(
                  'auto.components.sidebar.LinearAgentSkillSetupPrompt.remoteCopy',
                  'This installs host setup; remote agent environments may need separate setup.'
                )
              : agentRuntime.runtime === 'wsl'
                ? translate(
                    'auto.components.sidebar.LinearAgentSkillSetupPrompt.wslCopy',
                    'Install it for WSL agent handoffs from linked Linear work.'
                  )
                : translate(
                    'auto.components.sidebar.LinearAgentSkillSetupPrompt.hostCopy',
                    'Install it for host agent handoffs from linked Linear work.'
                  )}
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
