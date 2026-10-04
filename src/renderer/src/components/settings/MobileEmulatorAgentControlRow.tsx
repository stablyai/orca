import { Import } from 'lucide-react'
import {
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_NAME,
  ORCA_CLI_SKILL_UPDATE_COMMAND
} from '@/lib/agent-feature-install-commands'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { useMobileEmulatorAgentSetupState } from '../emulator-pane/use-mobile-emulator-agent-setup-state'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { buildSkillCommandForRuntime } from './CliSkillRuntimeSetup'
import { MobileEmulatorExamples } from './MobileEmulatorExamples'
import { translate } from '@/i18n/i18n'

const EMULATOR_CLI_COMMANDS = [
  'orca emulator list --json',
  'orca emulator attach "iPhone 16 Pro" --json',
  'orca emulator tap 0.5 0.7 --json',
  'orca emulator type "hello" --json'
] as const

export function MobileEmulatorAgentControlRow(): React.JSX.Element {
  const setup = useMobileEmulatorAgentSetupState(true)
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  // Why: skill detection here scans the local host only, so keep building host
  // commands; routing them to a WSL runtime would install where we never look.
  const cliSkillInstallCommand = buildSkillCommandForRuntime(ORCA_CLI_SKILL_INSTALL_COMMAND)
  const cliSkillUpdateCommand = buildSkillCommandForRuntime(ORCA_CLI_SKILL_UPDATE_COMMAND)

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
      </div>

      <div className="mt-3 divide-y divide-border/40">
        <div className="py-3">
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
            command={cliSkillInstallCommand}
            installedCommand={cliSkillUpdateCommand}
            terminalTitle="Orca CLI skill setup"
            terminalAriaLabel="Orca CLI skill install terminal"
            terminalWorktreeId="settings-mobile-emulator-orca-cli-skill-terminal"
            terminalShellOverride={activeSkillRuntime.terminalShellOverride}
            installed={setup.cliSkillInstalled}
            loading={setup.cliSkillLoading}
            error={setup.cliSkillError}
            onRecheck={setup.refreshCliSkill}
            freshnessSkillName={
              activeSkillRuntime.canUseLocalSkillFreshness ? ORCA_CLI_SKILL_NAME : undefined
            }
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
