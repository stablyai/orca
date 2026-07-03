import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { GlobalSettings } from '../../../../shared/types'
import {
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_NAME,
  ORCA_CLI_SKILL_UPDATE_COMMAND
} from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal,
  isOrcaCliAvailableOnPath
} from '@/lib/agent-skill-cli-prerequisite'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { CliRegistrationDialog } from './CliRegistrationDialog'
import {
  buildSkillCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getAgentSkillTerminalShellOverride,
  getSelectedAgentRuntime,
  getSkillDiscoveryTargetForRuntime,
  getWslCliDistroRequest
} from './CliSkillRuntimeSetup'
import { WslCliRegistration } from './WslCliRegistration'
import { translate } from '@/i18n/i18n'

type CliSectionProps = {
  currentPlatform: string
  settings: GlobalSettings
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslCapabilitiesLoading?: boolean
}

function getRevealLabel(platform: string): string {
  if (platform === 'darwin') {
    return 'Show in Finder'
  }
  if (platform === 'win32') {
    return 'Show in Explorer'
  }
  return 'Show in File Manager'
}

function getInstallDescription(platform: string): string {
  if (platform === 'darwin') {
    return 'Register `orca` in /usr/local/bin.'
  }
  if (platform === 'linux') {
    return 'Register `orca-ide` in ~/.local/bin.'
  }
  if (platform === 'win32') {
    return 'Register `orca` in your user PATH.'
  }
  return 'CLI registration is not yet available on this platform.'
}

function getFallbackCommandName(platform: string): string {
  return platform === 'linux' ? 'orca-ide' : 'orca'
}

export function CliSection({
  currentPlatform,
  settings,
  wslSupportedPlatform = false,
  wslAvailable = false,
  wslCapabilitiesLoading = false
}: CliSectionProps): React.JSX.Element {
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<'install' | 'remove' | null>(null)
  const mountedRef = useMountedRef()
  const agentRuntime = useMemo(
    () =>
      getSelectedAgentRuntime(settings, wslSupportedPlatform, wslAvailable, wslCapabilitiesLoading),
    [settings, wslAvailable, wslCapabilitiesLoading, wslSupportedPlatform]
  )
  const cliSkillDiscoveryTarget = useMemo(
    () => getSkillDiscoveryTargetForRuntime(agentRuntime),
    [agentRuntime]
  )
  const {
    installed: cliSkillDetected,
    loading: cliSkillLoading,
    error: cliSkillError,
    refresh: refreshCliSkill
  } = useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
    discoveryTarget: cliSkillDiscoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const cliSkillInstallCommand = buildSkillCommandForRuntime(
    ORCA_CLI_SKILL_INSTALL_COMMAND,
    agentRuntime
  )
  const cliSkillUpdateCommand = buildSkillCommandForRuntime(
    ORCA_CLI_SKILL_UPDATE_COMMAND,
    agentRuntime
  )
  const cliSkillTerminalShellOverride = getAgentSkillTerminalShellOverride(
    currentPlatform,
    settings,
    agentRuntime
  )
  const getCliSkillPrerequisiteStatus = useCallback(
    () =>
      agentRuntime.runtime === 'wsl'
        ? window.api.cli.getWslInstallStatus(getWslCliDistroRequest(agentRuntime))
        : window.api.cli.getInstallStatus(),
    [agentRuntime]
  )

  const handleStatusChange = useCallback(
    (nextStatus: CliInstallStatus): void => {
      if (mountedRef.current) {
        setStatus(nextStatus)
      }
    },
    [mountedRef]
  )

  const refreshStatus = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      handleStatusChange(await window.api.cli.getInstallStatus())
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.CliSection.7baec27029',
                'Failed to load CLI status.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [handleStatusChange, mountedRef])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const isEnabled = status?.state === 'installed'
  const isSupported = status?.supported ?? false
  const isBrowserManaged = status?.unsupportedReason === 'launch_mode_unavailable'
  const revealLabel = getRevealLabel(currentPlatform)
  const commandName = status?.commandName ?? getFallbackCommandName(currentPlatform)
  const canRevealCommandPath =
    status?.commandPath != null && ['installed', 'stale', 'conflict'].includes(status.state)

  const handleInstall = async (): Promise<void> => {
    setBusyAction('install')
    try {
      const next = await window.api.cli.install()
      if (mountedRef.current) {
        setStatus(next)
        setDialogOpen(false)
        toast.success(
          translate(
            'auto.components.settings.CliSection.9cbcd31338',
            'Registered `{{value0}}` in PATH.',
            { value0: next.commandName }
          )
        )
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.CliSection.a2b13efa94',
                'Failed to register `{{value0}}` in PATH.',
                { value0: commandName }
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setBusyAction(null)
      }
    }
  }

  const handleRemove = async (): Promise<void> => {
    setBusyAction('remove')
    try {
      const next = await window.api.cli.remove()
      if (mountedRef.current) {
        setStatus(next)
        setDialogOpen(false)
        toast.success(
          translate(
            'auto.components.settings.CliSection.af5540930c',
            'Removed `{{value0}}` from PATH.',
            { value0: next.commandName }
          )
        )
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.CliSection.d77352f2df',
                'Failed to remove `{{value0}}` from PATH.',
                { value0: commandName }
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setBusyAction(null)
      }
    }
  }

  return (
    <section className="space-y-4" data-settings-section="cli">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">
          {translate('auto.components.settings.CliSection.c5c0f2641d', 'Orca CLI')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CliSection.6930feda9e',
            'Use Orca from your terminal to open the app, manage worktrees, and interact with Orca terminals.'
          )}
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>
              {translate('auto.components.settings.CliSection.38edbb5721', 'Shell command')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {loading
                ? translate(
                    'auto.components.settings.CliSection.d363e5929b',
                    'Checking CLI registration…'
                  )
                : (status?.detail ?? getInstallDescription(currentPlatform))}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void refreshStatus()}
                    disabled={loading || busyAction !== null}
                    aria-label={translate(
                      'auto.components.settings.CliSection.52e640f3a0',
                      'Refresh CLI status'
                    )}
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {translate('auto.components.settings.CliSection.5dae812f50', 'Refresh')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {!isBrowserManaged ? (
              <button
                role="switch"
                aria-checked={isEnabled}
                disabled={loading || !isSupported || busyAction !== null}
                onClick={() => setDialogOpen(true)}
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors ${
                  isEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
                } ${loading || !isSupported || busyAction !== null ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
              >
                <span
                  className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                    isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            ) : null}
          </div>
        </div>

        {status?.commandPath ? (
          <p className="text-xs text-muted-foreground">
            {translate('auto.components.settings.CliSection.15eaad0d31', 'Command path:')}{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{status.commandPath}</code>
          </p>
        ) : null}

        {status?.state === 'stale' && status.currentTarget ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {translate(
              'auto.components.settings.CliSection.b0c310ab46',
              'Existing launcher target:'
            )}
            <code>{status.currentTarget}</code>
          </p>
        ) : null}

        {status?.state === 'installed' && !status.pathConfigured && status.pathDirectory ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {status.pathDirectory}{' '}
            {translate(
              'auto.components.settings.CliSection.7f2747f7dd',
              'is not currently visible on PATH for this shell.'
            )}
          </p>
        ) : null}

        {!loading && !isSupported && !isBrowserManaged && status?.detail ? (
          <p className="text-xs text-muted-foreground">{status.detail}</p>
        ) : null}

        <div className="flex items-center gap-2">
          {status?.commandPath ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void window.api.shell.openPath(status.commandPath as string)}
              disabled={loading || !canRevealCommandPath}
              className="gap-2"
            >
              <FolderOpen className="size-3.5" />
              {revealLabel}
            </Button>
          ) : null}
        </div>

        {!isBrowserManaged ? (
          <div className="border-t border-border/60 pt-3">
            <div className="space-y-0.5">
              <Label>
                {translate('auto.components.settings.CliSection.04873eea3e', 'Agent skills')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CliSection.36a6f919ba',
                  'Give agents Orca-aware workspace, terminal, and progress workflows.'
                )}
              </p>
            </div>

            <AgentSkillSetupPanel
              className="mt-3"
              variant="inline"
              title={translate('auto.components.settings.CliSection.6053cf736c', 'CLI skill')}
              description={translate(
                'auto.components.settings.CliSection.e8012c03a1',
                'Enables agents to use Orca workspace, terminal, and progress commands.'
              )}
              command={cliSkillInstallCommand}
              installedCommand={cliSkillUpdateCommand}
              terminalTitle="CLI skill setup"
              terminalAriaLabel="CLI skill install terminal"
              terminalWorktreeId={`settings-cli-skill-terminal-${agentRuntime.runtime}`}
              terminalShellOverride={cliSkillTerminalShellOverride}
              installed={cliSkillDetected}
              loading={cliSkillLoading}
              error={cliSkillError}
              preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
              getPrerequisiteStatus={getCliSkillPrerequisiteStatus}
              isPrerequisiteAvailable={isOrcaCliAvailableOnPath}
              onBeforeOpenTerminal={async () => {
                await (agentRuntime.runtime === 'wsl'
                  ? ensureWslCliAvailableForAgentSkillTerminal(agentRuntime)
                  : ensureOrcaCliAvailableForAgentSkillTerminal({
                      onStatusChange: handleStatusChange
                    }))
              }}
              onRecheck={refreshCliSkill}
            />
          </div>
        ) : null}
      </div>

      <WslCliRegistration currentPlatform={currentPlatform} />

      <CliRegistrationDialog
        busyAction={busyAction}
        commandName={commandName}
        commandPath={status?.commandPath}
        isEnabled={isEnabled}
        isSupported={isSupported}
        onInstall={handleInstall}
        onOpenChange={setDialogOpen}
        onRemove={handleRemove}
        open={dialogOpen}
      />
    </section>
  )
}
