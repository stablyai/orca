import { lazy, Suspense, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '../../../ui/button'
import {
  hermesProfileFromHome,
  hermesSetupCommand,
  type HermesSetupAction
} from './hermes-setup-commands'

const OnboardingInlineCommandTerminal = lazy(() =>
  import('../../../onboarding/OnboardingInlineCommandTerminal').then((module) => ({
    default: module.OnboardingInlineCommandTerminal
  }))
)

/** Runs Hermes's own checks against the profile its chats use, in a terminal the person starts. */
export function HermesSetupSection({
  commandOverride,
  hermesHome
}: {
  commandOverride: string | undefined
  hermesHome: string | undefined
}): React.JSX.Element {
  const [action, setAction] = useState<HermesSetupAction | null>(null)
  const profile = hermesProfileFromHome(hermesHome)
  const executable = commandOverride?.trim() || 'hermes'
  const actions: { id: HermesSetupAction; label: string }[] = [
    {
      id: 'version',
      label: translate('auto.components.settings.HermesSetupSection.version', 'Show version')
    },
    {
      id: 'acp-check',
      label: translate('auto.components.settings.HermesSetupSection.acpCheck', 'Run ACP check')
    },
    {
      id: 'setup',
      label: translate('auto.components.settings.HermesSetupSection.setup', 'Set up profile')
    }
  ]

  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground">
        {profile
          ? translate(
              'auto.components.settings.HermesSetupSection.profile',
              'Checks use the Hermes profile {{profile}} from HERMES_HOME.',
              { profile }
            )
          : translate(
              'auto.components.settings.HermesSetupSection.defaultProfile',
              'Checks use the default Hermes profile. Set HERMES_HOME to a profile folder to check that profile.'
            )}
      </span>
      <div className="flex flex-wrap gap-2">
        {actions.map(({ id, label }) => (
          <Button
            key={id}
            variant="outline"
            size="xs"
            disabled={action !== null}
            onClick={() => setAction(id)}
          >
            {label}
          </Button>
        ))}
        {action ? (
          <Button variant="ghost" size="xs" onClick={() => setAction(null)}>
            {translate('auto.components.settings.HermesSetupSection.close', 'Close terminal')}
          </Button>
        ) : null}
      </div>
      {action ? (
        <Suspense
          fallback={
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.HermesSetupSection.loading',
                'Loading terminal…'
              )}
            </p>
          }
        >
          <OnboardingInlineCommandTerminal
            command={hermesSetupCommand(executable, profile, action)}
            title={translate('auto.components.settings.HermesSetupSection.terminalTitle', 'Hermes')}
            ariaLabel={translate(
              'auto.components.settings.HermesSetupSection.terminalLabel',
              'Hermes setup terminal'
            )}
            description={translate(
              'auto.components.settings.HermesSetupSection.instructions',
              'Press Enter to run the command.'
            )}
            autoScrollIntoView={false}
            terminalTopMarginPx={8}
            worktreeId="hermes-setup-terminal"
          />
        </Suspense>
      ) : null}
    </div>
  )
}
