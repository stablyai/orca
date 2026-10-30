import { lazy, Suspense, useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { ZcodeSetupInvocation } from '../../../../preload/api/preflight-api'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { getHostShellForProjectRuntime } from '../../../../shared/local-windows-terminal-runtime'
import { buildZcodeSetupTerminalCommand } from './zcode-setup-terminal-command'

const OnboardingInlineCommandTerminal = lazy(() =>
  import('../onboarding/OnboardingInlineCommandTerminal').then((module) => ({
    default: module.OnboardingInlineCommandTerminal
  }))
)

type SetupChoice = 'zai' | 'bigmodel' | 'api-key'

type SetupTerminal = {
  choice: SetupChoice
  invocation: ZcodeSetupInvocation
}

export function ZcodeCliSetupSection(): React.JSX.Element {
  const commandOverride = useAppStore((s) => s.settings?.agentCmdOverrides?.zcode)?.trim()
  const windowsShell = useAppStore((s) => s.settings?.terminalWindowsShell)
  const setupShell = navigator.userAgent.includes('Windows')
    ? getHostShellForProjectRuntime(undefined, windowsShell)
    : undefined
  const [loadingChoice, setLoadingChoice] = useState<SetupChoice | null>(null)
  const [terminal, setTerminal] = useState<SetupTerminal | null>(null)
  const openSetup = useCallback(
    async (choice: SetupChoice): Promise<void> => {
      setLoadingChoice(choice)
      try {
        if (choice === 'api-key') {
          const capability = await window.api.preflight.zcodeInteractiveCapability(
            commandOverride ? { commandOverride } : undefined
          )
          if (capability === 'missing-tui') {
            toast.error(
              translate(
                'auto.components.terminal.pane.zcode.missing.tui.title',
                'This ZCode build has no terminal UI'
              ),
              {
                description: translate(
                  'auto.components.settings.ZcodeCliSetupSection.apiKeyTuiRequired',
                  'The ZCode desktop bundle can run browser sign-in, but API-key setup requires a standalone ZCode CLI that ships the terminal UI.'
                )
              }
            )
            return
          }
        }
        const cliArgs = choice === 'api-key' ? ['tui'] : ['login', choice, '--no-browser']
        const invocation = await window.api.preflight.zcodeSetupInvocation({
          ...(commandOverride ? { commandOverride } : {}),
          cliArgs
        })
        setTerminal({ choice, invocation })
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.ZcodeCliSetupSection.resolveFailed',
                'Could not resolve the installed ZCode CLI.'
              )
        )
      } finally {
        setLoadingChoice(null)
      }
    },
    [commandOverride]
  )

  const title = translate(
    'auto.components.settings.ZcodeCliSetupSection.title',
    'Use GLM with ZCode'
  )
  const description = translate(
    'auto.components.settings.ZcodeCliSetupSection.description',
    'Sign in to use GLM as a coding agent. The quota API key above only monitors usage; ZCode owns its own sign-in and model selection.'
  )
  const busy = loadingChoice !== null || terminal !== null

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
        <Button variant="outline" size="xs" disabled={busy} onClick={() => void openSetup('zai')}>
          {translate('auto.components.settings.ZcodeCliSetupSection.zai', 'Z.AI browser sign-in')}
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => void openSetup('bigmodel')}
        >
          {translate(
            'auto.components.settings.ZcodeCliSetupSection.bigmodel',
            'BigModel browser sign-in'
          )}
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={() => void openSetup('api-key')}
        >
          {translate('auto.components.settings.ZcodeCliSetupSection.apiKey', 'ZCode API-key setup')}
        </Button>
        {terminal ? (
          <Button variant="ghost" size="xs" onClick={() => setTerminal(null)}>
            {translate(
              'auto.components.settings.ZcodeCliSetupSection.close',
              'Close setup terminal'
            )}
          </Button>
        ) : null}
      </div>
      {loadingChoice ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ZcodeCliSetupSection.loading',
            'Loading sign-in terminal…'
          )}
        </p>
      ) : null}
      {terminal ? (
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
            command="zcode"
            prepareCommandForShell={(_command, shell) =>
              buildZcodeSetupTerminalCommand(terminal.invocation, shell)
            }
            title={translate(
              'auto.components.settings.ZcodeCliSetupSection.terminalTitle',
              'ZCode sign-in'
            )}
            ariaLabel={translate(
              'auto.components.settings.ZcodeCliSetupSection.terminalLabel',
              'ZCode sign-in terminal'
            )}
            description={
              terminal.choice === 'api-key'
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
            shellOverride={setupShell}
            forceHostRuntime
          />
        </Suspense>
      ) : null}
    </SearchableSetting>
  )
}
