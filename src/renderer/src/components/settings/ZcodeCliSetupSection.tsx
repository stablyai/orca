import { lazy, Suspense, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'

const OnboardingInlineCommandTerminal = lazy(() =>
  import('../onboarding/OnboardingInlineCommandTerminal').then((module) => ({
    default: module.OnboardingInlineCommandTerminal
  }))
)

type SetupChoice = 'zai' | 'bigmodel' | 'api-key'

export function ZcodeCliSetupSection(): React.JSX.Element {
  const commandOverride = useAppStore((s) => s.settings?.agentCmdOverrides?.zcode)
  const [choice, setChoice] = useState<SetupChoice | null>(null)
  const executable = commandOverride?.trim() || 'zcode'
  const command = choice === 'api-key' ? executable : `${executable} login ${choice} --no-browser`

  const title = translate(
    'auto.components.settings.ZcodeCliSetupSection.title',
    'Use GLM with ZCode'
  )
  const description = translate(
    'auto.components.settings.ZcodeCliSetupSection.description',
    'Sign in to use GLM as a coding agent. The quota API key above only monitors usage; ZCode owns its own sign-in and model selection.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['zcode', 'glm', 'oauth', 'login', 'model', 'api key']}
      className="space-y-2"
    >
      <h4 className="text-xs font-medium">{title}</h4>
      <p className="text-xs text-muted-foreground">{description}</p>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.ZcodeCliSetupSection.help',
          'Choose browser sign-in for your plan site, or use ZCode’s masked API-key setup. After signing in, start ZCode and use /model to choose a GLM model.'
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="xs"
          disabled={choice !== null}
          onClick={() => setChoice('zai')}
        >
          {translate('auto.components.settings.ZcodeCliSetupSection.zai', 'Z.AI browser sign-in')}
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={choice !== null}
          onClick={() => setChoice('bigmodel')}
        >
          {translate(
            'auto.components.settings.ZcodeCliSetupSection.bigmodel',
            'BigModel browser sign-in'
          )}
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={choice !== null}
          onClick={() => setChoice('api-key')}
        >
          {translate('auto.components.settings.ZcodeCliSetupSection.apiKey', 'ZCode API-key setup')}
        </Button>
        {choice ? (
          <Button variant="ghost" size="xs" onClick={() => setChoice(null)}>
            {translate(
              'auto.components.settings.ZcodeCliSetupSection.close',
              'Close setup terminal'
            )}
          </Button>
        ) : null}
      </div>
      {choice ? (
        <Suspense
          fallback={
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.ZcodeCliSetupSection.loading',
                'Loading sign-in terminal…'
              )}
            </p>
          }
        >
          <OnboardingInlineCommandTerminal
            command={command}
            title={translate(
              'auto.components.settings.ZcodeCliSetupSection.terminalTitle',
              'ZCode sign-in'
            )}
            ariaLabel={translate(
              'auto.components.settings.ZcodeCliSetupSection.terminalLabel',
              'ZCode sign-in terminal'
            )}
            description={
              choice === 'api-key'
                ? translate(
                    'auto.components.settings.ZcodeCliSetupSection.apiKeyInstructions',
                    'Press Enter to start ZCode, then enter /login and choose the API-key option for your plan site. Enter the key in ZCode’s masked prompt.'
                  )
                : translate(
                    'auto.components.settings.ZcodeCliSetupSection.oauthInstructions',
                    'Press Enter to run the sign-in command, then open the authorization URL printed by ZCode. Sign-in is saved on this terminal’s execution host.'
                  )
            }
            autoScrollIntoView={false}
            terminalTopMarginPx={8}
            worktreeId="zcode-sign-in-terminal"
          />
        </Suspense>
      ) : null}
    </SearchableSetting>
  )
}
