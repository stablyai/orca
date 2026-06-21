import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { SearchableSetting } from './SearchableSetting'
import { StepBadge } from './BrowserUseStepBadge'
import { getBrowserUsePaneSearchEntries } from './browser-use-search'
import { translate } from '@/i18n/i18n'

type BrowserUseCliStepProps = {
  cliStatus: CliInstallStatus | null
  cliEnabled: boolean
  cliLoading: boolean
  cliBusy: boolean
  cliSupported: boolean
  cliPathNeedsAttention: boolean
  onEnableCli: () => void
}

export function BrowserUseCliStep({
  cliStatus,
  cliEnabled,
  cliLoading,
  cliBusy,
  cliSupported,
  cliPathNeedsAttention,
  onEnableCli
}: BrowserUseCliStepProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate('auto.components.settings.BrowserUsePane.c6065d205d', 'Enable Orca CLI')}
      description={translate(
        'auto.components.settings.BrowserUsePane.c79eff0213',
        'Register the Orca CLI so agents can drive the browser.'
      )}
      keywords={getBrowserUsePaneSearchEntries()[0].keywords}
      className="rounded-xl border border-border/60 bg-card/50 p-4"
    >
      <div className="flex items-start gap-3">
        <StepBadge index={1} state={cliEnabled ? 'done' : cliBusy ? 'in-progress' : 'pending'} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">
            {translate('auto.components.settings.BrowserUsePane.c6065d205d', 'Enable Orca CLI')}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.BrowserUsePane.9fca1f7f5d',
              'Registers the Orca CLI command so agents can orchestrate the browser from their shell.'
            )}
          </p>
          {cliStatus?.commandPath && cliEnabled ? (
            <p className="text-[11px] text-muted-foreground">
              {translate('auto.components.settings.BrowserUsePane.e9f3f3b488', 'Installed at')}{' '}
              <code className="rounded bg-muted px-1 py-0.5">{cliStatus.commandPath}</code>
            </p>
          ) : null}
          {cliPathNeedsAttention && cliStatus?.detail ? (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">{cliStatus.detail}</p>
          ) : null}
        </div>
        <TooltipProvider delayDuration={250}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  size="sm"
                  variant={cliEnabled ? 'outline' : 'default'}
                  disabled={cliLoading || cliBusy || !cliSupported || cliEnabled}
                  onClick={() => void onEnableCli()}
                >
                  {cliBusy
                    ? translate(
                        'auto.components.settings.BrowserUsePane.8b3054dac7',
                        'Registering...'
                      )
                    : cliEnabled
                      ? translate('auto.components.settings.BrowserUsePane.0289434ed6', 'Enabled')
                      : cliPathNeedsAttention
                        ? translate(
                            'auto.components.settings.BrowserUsePane.ad8cb0ee22',
                            'Fix PATH'
                          )
                        : translate('auto.components.settings.BrowserUsePane.de9b2f32f3', 'Enable')}
                </Button>
              </span>
            </TooltipTrigger>
            {!cliSupported && !cliLoading && cliStatus?.detail ? (
              <TooltipContent side="left" sideOffset={6}>
                {cliStatus.detail}
              </TooltipContent>
            ) : null}
          </Tooltip>
        </TooltipProvider>
      </div>
    </SearchableSetting>
  )
}
