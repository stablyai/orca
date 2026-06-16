import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { ORCA_CLI_SKILL_INSTALL_COMMAND } from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import { AgentSkillSetupPanel } from '../settings/AgentSkillSetupPanel'
import { StepBadge } from '../settings/BrowserUseStepBadge'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import {
  getMobileEmulatorCliStepBadgeState,
  shouldShowMobileEmulatorSkillPreInstallNotice
} from './mobile-emulator-agent-setup-cli-state'
import type { useMobileEmulatorAgentSetupState } from './use-mobile-emulator-agent-setup-state'
import { translate } from '@/i18n/i18n'

type MobileEmulatorAgentSetupGuideStepsProps = {
  setup: ReturnType<typeof useMobileEmulatorAgentSetupState>
  worktreeId: string
}

export function MobileEmulatorAgentSetupGuideSteps({
  setup,
  worktreeId
}: MobileEmulatorAgentSetupGuideStepsProps): React.JSX.Element {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const terminalWorktreeId = `mobile-emulator-${worktreeId}-orca-cli-skill-terminal`
  const showSkillPreInstallNotice = shouldShowMobileEmulatorSkillPreInstallNotice({
    cliEnabled: setup.cliEnabled,
    cliSkillInstalled: setup.cliSkillInstalled
  })

  return (
    <div className="divide-y divide-border/40">
      <div className="flex items-center gap-3 py-2.5">
        <StepBadge
          index={1}
          state={getMobileEmulatorCliStepBadgeState({
            cliBusy: setup.cliBusy,
            cliEnabled: setup.cliEnabled,
            cliPathNeedsAttention: setup.cliPathNeedsAttention
          })}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">
            {translate(
              'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.9b49d892e3',
              'Enable Orca CLI'
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.3d8dc52c93',
              'Registers the orca command for emulator control in agent shells.'
            )}
          </p>
          {setup.cliInstallStatus?.commandPath && setup.cliEnabled ? (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.MobileEmulatorAgentControlRow.aaf62a3dd2',
                'Installed at'
              )}{' '}
              <code className="rounded bg-muted px-1 py-0.5">
                {setup.cliInstallStatus.commandPath}
              </code>
            </p>
          ) : null}
          {setup.cliPathNeedsAttention && setup.cliInstallStatus?.detail ? (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              {setup.cliInstallStatus.detail}
            </p>
          ) : null}
          {!setup.cliEnabled && !setup.cliPathNeedsAttention && setup.cliInstallStatus?.detail ? (
            <p className="text-[11px] text-muted-foreground">{setup.cliInstallStatus.detail}</p>
          ) : null}
        </div>
        <TooltipProvider delayDuration={250}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="button"
                  size="sm"
                  variant={setup.cliEnabled ? 'outline' : 'default'}
                  disabled={
                    setup.cliLoading || setup.cliBusy || !setup.cliSupported || setup.cliEnabled
                  }
                  onClick={() => {
                    recordFeatureInteraction('mobile-emulator-agent-setup')
                    void setup.handleEnableCli()
                  }}
                >
                  {setup.cliLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {setup.cliActionLabel}
                </Button>
              </span>
            </TooltipTrigger>
            {!setup.cliSupported && !setup.cliLoading && setup.cliInstallStatus?.detail ? (
              <TooltipContent side="left" sideOffset={6}>
                {setup.cliInstallStatus.detail}
              </TooltipContent>
            ) : null}
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className={cn('flex items-start gap-3 py-2.5', setup.step2Blocked && 'opacity-60')}>
        <div className="mt-0.5 shrink-0">
          <StepBadge index={2} state={setup.cliSkillInstalled ? 'done' : 'pending'} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {translate(
              'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.21f5687c07',
              'Orca CLI skill'
            )}
          </p>
          <AgentSkillSetupPanel
            variant="inline"
            hideHeader
            className="min-w-0"
            title={translate(
              'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.21f5687c07',
              'Orca CLI skill'
            )}
            description={translate(
              'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.64fb057667',
              'Teaches agents the orca emulator commands for this worktree.'
            )}
            command={ORCA_CLI_SKILL_INSTALL_COMMAND}
            terminalTitle={translate(
              'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.5c59ea96ca',
              'Mobile emulator Orca CLI skill setup'
            )}
            terminalAriaLabel={translate(
              'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.bff5341ac3',
              'Mobile emulator Orca CLI skill install terminal'
            )}
            terminalWorktreeId={terminalWorktreeId}
            installed={setup.cliSkillInstalled}
            loading={setup.cliSkillLoading || setup.setupRechecking}
            error={setup.cliSkillError}
            installDisabled={setup.step2Blocked}
            showInstallWhenInstalled={!setup.cliSkillInstalled}
            terminalHeightPx={112}
            preInstallNotice={
              showSkillPreInstallNotice ? AGENT_SKILL_CLI_PREREQUISITE_NOTICE : undefined
            }
            onBeforeOpenTerminal={async () => {
              recordFeatureInteraction('mobile-emulator-agent-setup')
              await ensureOrcaCliAvailableForAgentSkillTerminal()
            }}
            onRecheck={() => {
              recordFeatureInteraction('mobile-emulator-agent-setup')
              void setup.recheckSetup()
            }}
          />
        </div>
      </div>
    </div>
  )
}
