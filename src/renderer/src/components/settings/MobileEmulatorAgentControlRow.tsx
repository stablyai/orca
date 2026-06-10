import { useCallback, useEffect, useState } from 'react'
import { Import, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import {
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_NAME
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
import { cn } from '@/lib/utils'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { StepBadge } from './BrowserUseStepBadge'
import { MobileEmulatorExamples } from './MobileEmulatorExamples'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'

const EMULATOR_CLI_COMMANDS = [
  'orca emulator list --json',
  'orca emulator attach "iPhone 16 Pro" --json',
  'orca emulator tap 0.5 0.7 --json',
  'orca emulator type "hello" --json'
] as const

function getCliActionLabel(status: CliInstallStatus | null, busy: boolean): string {
  if (busy) {
    return 'Registering...'
  }
  if (isOrcaCliAvailableOnPath(status)) {
    return 'Enabled'
  }
  if (status?.state === 'installed') {
    return 'Fix PATH'
  }
  return 'Enable'
}

export function MobileEmulatorAgentControlRow(): React.JSX.Element {
  const [cliInstallStatus, setCliInstallStatus] = useState<CliInstallStatus | null>(null)
  const [cliLoading, setCliLoading] = useState(true)
  const [cliBusy, setCliBusy] = useState(false)
  const mountedRef = useMountedRef()
  const {
    installed: cliSkillInstalled,
    loading: cliSkillLoading,
    error: cliSkillError,
    refresh: refreshCliSkill
  } = useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  const refreshCliStatus = useCallback(async (): Promise<void> => {
    setCliLoading(true)
    try {
      setCliInstallStatus(await window.api.cli.getInstallStatus())
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.MobileEmulatorAgentControlRow.1861982430',
                'Failed to load CLI status.'
              )
        )
      }
      setCliInstallStatus(null)
    } finally {
      if (mountedRef.current) {
        setCliLoading(false)
      }
    }
  }, [mountedRef])

  useEffect(() => {
    void refreshCliStatus()
  }, [refreshCliStatus])

  const cliEnabled = isOrcaCliAvailableOnPath(cliInstallStatus)
  const cliSupported = cliInstallStatus?.supported ?? false
  const completedCount = [cliEnabled, cliSkillInstalled].filter(Boolean).length
  const step2Blocked = !cliEnabled && !cliSkillInstalled

  const handleEnableCli = async (): Promise<void> => {
    setCliBusy(true)
    try {
      const next = await ensureOrcaCliAvailableForAgentSkillTerminal({
        onStatusChange: setCliInstallStatus
      })
      if (mountedRef.current && isOrcaCliAvailableOnPath(next)) {
        toast.success(
          translate(
            'auto.components.settings.MobileEmulatorAgentControlRow.cdeaed9e37',
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

  return (
    <div className="rounded-2xl border border-border/60 bg-card/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm font-semibold">
            {translate(
              'auto.components.settings.MobileEmulatorAgentControlRow.2a674aa810',
              'Agent Mobile Emulator Control'
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.MobileEmulatorAgentControlRow.ff4b7e65d6',
              'Let coding agents control the active mobile emulator with Orca CLI commands.'
            )}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            completedCount === 2
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-muted text-muted-foreground'
          }`}
        >
          {completedCount}/2
        </span>
      </div>

      <div className="mt-3 divide-y divide-border/40">
        <div className="flex items-start gap-3 py-3">
          <StepBadge index={1} state={cliEnabled ? 'done' : cliBusy ? 'in-progress' : 'pending'} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">
              {translate(
                'auto.components.settings.MobileEmulatorAgentControlRow.4f2205f3b6',
                'Enable Orca CLI'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.MobileEmulatorAgentControlRow.2fef055608',
                'Registers the Orca CLI command so agents can control the active emulator from their shell.'
              )}
            </p>
            {cliInstallStatus?.commandPath && cliEnabled ? (
              <p className="text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.settings.MobileEmulatorAgentControlRow.aaf62a3dd2',
                  'Installed at'
                )}{' '}
                <code className="rounded bg-muted px-1 py-0.5">{cliInstallStatus.commandPath}</code>
              </p>
            ) : null}
            {!cliEnabled && cliInstallStatus?.detail ? (
              <p className="text-[11px] text-muted-foreground">{cliInstallStatus.detail}</p>
            ) : null}
          </div>
          <TooltipProvider delayDuration={250}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    size="sm"
                    variant={cliEnabled ? 'outline' : 'default'}
                    disabled={cliLoading || cliBusy || !cliSupported || cliEnabled}
                    onClick={() => void handleEnableCli()}
                  >
                    {cliLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {getCliActionLabel(cliInstallStatus, cliBusy)}
                  </Button>
                </span>
              </TooltipTrigger>
              {!cliSupported && !cliLoading && cliInstallStatus?.detail ? (
                <TooltipContent side="left" sideOffset={6}>
                  {cliInstallStatus.detail}
                </TooltipContent>
              ) : null}
            </Tooltip>
          </TooltipProvider>
        </div>

        <div className={cn('py-3', step2Blocked && 'opacity-60')}>
          <AgentSkillSetupPanel
            variant="inline"
            title={translate(
              'auto.components.settings.MobileEmulatorAgentControlRow.67e19ee03c',
              'Orca CLI skill'
            )}
            description={translate(
              'auto.components.settings.MobileEmulatorAgentControlRow.d94ca6a623',
              'Enables agents to use Orca CLI commands, including mobile emulator control.'
            )}
            command={ORCA_CLI_SKILL_INSTALL_COMMAND}
            terminalTitle="Orca CLI skill setup"
            terminalAriaLabel="Orca CLI skill install terminal"
            terminalWorktreeId="settings-mobile-emulator-orca-cli-skill-terminal"
            installed={cliSkillInstalled}
            loading={cliSkillLoading}
            error={cliSkillError}
            installDisabled={step2Blocked}
            leading={<StepBadge index={2} state={cliSkillInstalled ? 'done' : 'pending'} />}
            preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
            onBeforeOpenTerminal={async () => {
              await ensureOrcaCliAvailableForAgentSkillTerminal({
                onStatusChange: setCliInstallStatus
              })
            }}
            onRecheck={refreshCliSkill}
          />
        </div>

        <div className="py-3">
          <div className="flex items-center gap-2">
            <Import className="size-3.5 text-muted-foreground" />
            <p className="text-sm font-medium">
              {translate(
                'auto.components.settings.MobileEmulatorAgentControlRow.c7f3fe0a6e',
                'Common emulator commands'
              )}
            </p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.MobileEmulatorAgentControlRow.8af7a8bc38',
              'Commands target the active emulator for the current worktree. Coordinates are normalized from 0..1.'
            )}
          </p>
          <div className="mt-3 grid gap-1.5 [@media(min-width:520px)]:grid-cols-2">
            {EMULATOR_CLI_COMMANDS.map((command) => (
              <code
                key={command}
                className="block break-all rounded-md border border-border/60 bg-background/60 px-2 py-1 font-mono text-[11px] leading-snug text-foreground"
              >
                {command}
              </code>
            ))}
          </div>
        </div>

        <MobileEmulatorExamples variant="inline" />
      </div>
    </div>
  )
}
