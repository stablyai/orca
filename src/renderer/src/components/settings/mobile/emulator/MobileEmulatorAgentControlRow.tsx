import { Import } from 'lucide-react'
import { ORCA_CLI_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import { useMobileEmulatorAgentSetupState } from '../../../emulator-pane/use-mobile-emulator-agent-setup-state'
import { AgentSkillSetupPanel } from '../../../skills/setup/AgentSkillSetupPanel'
import { MobileEmulatorExamples } from './MobileEmulatorExamples'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

const EMULATOR_CLI_COMMANDS = [
  'orca emulator list --json',
  'orca emulator attach "iPhone 16 Pro" --json',
  'orca emulator tap 0.5 0.7 --json',
  'orca emulator type "hello" --json'
] as const

export function MobileEmulatorAgentControlRow(): React.JSX.Element {
  const t = useTranslate()
  const setup = useMobileEmulatorAgentSetupState(true)
  const activeSkillRuntime = setup.skillRuntime

  return (
    <SettingsGroup
      title={t(
        'auto.components.settings.MobileEmulatorAgentControlRow.2a674aa810',
        'Agent Mobile Emulator Control'
      )}
      description={t(
        'auto.components.settings.MobileEmulatorAgentControlRow.ff4b7e65d6',
        'Let coding agents control the active mobile emulator with Orca CLI commands.'
      )}
    >
      <div className="divide-y divide-border">
        <div className="py-3">
          <AgentSkillSetupPanel
            variant="inline"
            title={t(
              'auto.components.settings.MobileEmulatorAgentControlRow.67e19ee03c',
              'Orca CLI skill'
            )}
            description={t(
              'auto.components.settings.MobileEmulatorAgentControlRow.d94ca6a623',
              'Enables agents to use Orca CLI commands, including mobile emulator control.'
            )}
            skillNames={[ORCA_CLI_SKILL_NAME]}
            target={activeSkillRuntime.bundledSkillTarget}
            terminalRuntime={activeSkillRuntime.agentRuntime}
            installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
            installed={setup.cliSkillInstalled}
            loading={setup.cliSkillLoading}
            error={setup.cliSkillError}
            onRecheck={setup.refreshCliSkill}
            freshnessSkillName={
              activeSkillRuntime.canUseSkillFreshness ? ORCA_CLI_SKILL_NAME : undefined
            }
          />
        </div>

        <div className="py-3">
          <div className="flex items-center gap-2">
            <Import className="size-3.5 text-muted-foreground" />
            <p className="text-sm font-medium">
              {t(
                'auto.components.settings.MobileEmulatorAgentControlRow.c7f3fe0a6e',
                'Common emulator commands'
              )}
            </p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
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
    </SettingsGroup>
  )
}
