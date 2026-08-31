import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import {
  getAgentAwakeDescription,
  getAgentAwakeModeLabel,
  getAmphetamineIntegrationDescription,
  getAmphetamineIntegrationSearchKeywords,
  getAmphetamineIntegrationTitle,
  getAgentAwakeSearchKeywords,
  getAgentAwakeTitle
} from './agent-awake-copy'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSegmentedControl } from './SettingsFormControls'
import {
  computerAwakeSettingsForMacosEngine,
  computerAwakeSettingsForMode,
  normalizeComputerAwakeMode,
  normalizeMacosAwakeEngine,
  type ComputerAwakeMode,
  type ComputerAwakeStatus,
  type MacosAwakeEngine
} from '../../../../shared/computer-awake-mode'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { translate } from '@/i18n/i18n'
import {
  openAmphetamineListing,
  refreshAmphetamineInstallation
} from '@/lib/amphetamine-installation'

type AgentAwakeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** Live integration availability and status; the caller owns the subscription. */
  awakeStatus?: ComputerAwakeStatus
}

export function AgentAwakeSetting({
  settings,
  updateSettings,
  awakeStatus
}: AgentAwakeSettingProps): React.JSX.Element {
  const title = getAgentAwakeTitle()
  const description = getAgentAwakeDescription()
  const mode = normalizeComputerAwakeMode(
    settings.computerAwakeMode,
    settings.keepComputerAwakeWhileAgentsRun
  )
  const isMac = getRendererAppPlatform() === 'darwin'
  const engine = normalizeMacosAwakeEngine(settings.computerAwakeMacosEngine)
  const setMode = (nextMode: ComputerAwakeMode): void => {
    updateSettings(computerAwakeSettingsForMode(nextMode))
  }
  const setEngine = (nextEngine: MacosAwakeEngine): void => {
    updateSettings(computerAwakeSettingsForMacosEngine(nextEngine))
  }

  return (
    <section className="space-y-3">
      <SearchableSetting
        title={title}
        description={description}
        keywords={getAgentAwakeSearchKeywords()}
      >
        <div className="flex items-start justify-between gap-4 py-2">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label>{title}</Label>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <SettingsSegmentedControl
            value={mode}
            onChange={setMode}
            ariaLabel={title}
            size="sm"
            options={[
              {
                value: 'on',
                label: getAgentAwakeModeLabel('on')
              },
              {
                value: 'auto',
                label: getAgentAwakeModeLabel('auto')
              },
              {
                value: 'off',
                label: getAgentAwakeModeLabel('off')
              }
            ]}
          />
        </div>
      </SearchableSetting>
      {isMac ? (
        <AmphetamineIntegrationSetting
          engine={engine}
          awakeStatus={awakeStatus}
          onChange={setEngine}
        />
      ) : null}
    </section>
  )
}

function AmphetamineIntegrationSetting({
  engine,
  awakeStatus,
  onChange
}: {
  engine: MacosAwakeEngine
  awakeStatus?: ComputerAwakeStatus
  onChange: (engine: MacosAwakeEngine) => void
}): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [actionFailure, setActionFailure] = useState<'check' | 'open' | null>(null)
  const title = getAmphetamineIntegrationTitle()
  const description = getAmphetamineIntegrationDescription(
    awakeStatus?.amphetamineInstalled,
    awakeStatus?.amphetamineUnavailableReason
  )
  const notInstalled =
    awakeStatus?.amphetamineInstalled === false ||
    awakeStatus?.amphetamineUnavailableReason === 'not-installed'
  const automationDenied = awakeStatus?.amphetamineUnavailableReason === 'automation-denied'
  const amphetamineSelectable = awakeStatus?.amphetamineInstalled === true
  const canRetryAvailability = !amphetamineSelectable || automationDenied

  const checkAgain = async (): Promise<void> => {
    setChecking(true)
    setActionFailure(null)
    try {
      const installed = await refreshAmphetamineInstallation()
      if (installed === undefined) {
        setActionFailure('check')
      }
    } catch {
      setActionFailure('check')
    } finally {
      setChecking(false)
    }
  }

  const openListing = async (): Promise<void> => {
    setActionFailure(null)
    try {
      await openAmphetamineListing()
    } catch {
      setActionFailure('open')
    }
  }

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={getAmphetamineIntegrationSearchKeywords()}
    >
      <div className="flex flex-col items-start gap-3 py-2 sm:flex-row sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>{title}</Label>
          <p className="text-xs text-muted-foreground">{description}</p>
          {canRetryAvailability ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {notInstalled ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void openListing()}
                >
                  {translate(
                    'auto.components.settings.AgentAwakeSetting.getAmphetamine',
                    'Get Amphetamine…'
                  )}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={checking}
                onClick={() => void checkAgain()}
              >
                {checking
                  ? translate('auto.components.settings.AgentAwakeSetting.checking', 'Checking…')
                  : translate(
                      'auto.components.settings.AgentAwakeSetting.checkAgain',
                      'Check again'
                    )}
              </Button>
              {actionFailure ? (
                <span role="alert" className="text-xs text-destructive">
                  {actionFailure === 'open'
                    ? translate(
                        'auto.components.settings.AgentAwakeSetting.openFailed',
                        'Couldn’t open the Amphetamine listing. Try again.'
                      )
                    : translate(
                        'auto.components.settings.AgentAwakeSetting.checkFailed',
                        'Couldn’t check for Amphetamine. Try again.'
                      )}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <SettingsSegmentedControl
          value={engine}
          onChange={onChange}
          ariaLabel={title}
          size="sm"
          options={[
            {
              value: 'caffeinate',
              label: translate(
                'auto.components.settings.AgentAwakeSetting.builtInOnly',
                'Built-in only'
              )
            },
            {
              value: 'amphetamine',
              label: translate(
                'auto.components.settings.AgentAwakeSetting.addAmphetamine',
                'Amphetamine (read-only)'
              ),
              disabled: !amphetamineSelectable
            }
          ]}
        />
      </div>
    </SearchableSetting>
  )
}
