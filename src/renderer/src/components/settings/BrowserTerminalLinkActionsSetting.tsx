import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { SearchableSetting } from './SearchableSetting'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'
import { getTerminalLinkActionSearchKeywords } from './browser-search'
import {
  terminalLinkClickBehaviorFor,
  type TerminalLinkClickBehavior
} from '../terminal-pane/terminal-link-click-behavior'

type BrowserTerminalLinkActionsSettingProps = {
  settings: Pick<
    GlobalSettings,
    | 'terminalLinkActionPopoverEnabled'
    | 'terminalLinkClickBehavior'
    | 'terminalUrlMiddleClickBehavior'
  >
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserTerminalLinkActionsSetting({
  settings,
  isMac,
  updateSettings
}: BrowserTerminalLinkActionsSettingProps): React.JSX.Element {
  const title = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.title',
    'Terminal URL clicks'
  )
  const description = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.descriptionV2',
    'Control clicks on detected URLs printed in terminal panes and chat transcripts.'
  )
  const behavior = terminalLinkClickBehaviorFor(settings)
  const plainClickLabel = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.plainClickLabel',
    'Plain click'
  )
  const plainClickDescription = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.plainClickDescription',
    'Choose whether a left-click shows actions, opens the URL, or leaves it to the terminal. Cmd/Ctrl-click always opens directly.'
  )
  const plainClickAriaLabel = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.plainClickAriaLabel',
    'Plain click URL behavior'
  )
  const middleClickLabel = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.middleClickLabel',
    'Middle click'
  )
  const middleClickDescription = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.middleClickDescription',
    'Choose what a mouse-wheel click does on a detected terminal URL.'
  )
  const middleClickAriaLabel = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.middleClickAriaLabel',
    'Middle click'
  )
  const actionsLabel = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.actionsLabel',
    'Actions'
  )
  const openUrlLabel = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.openUrlLabel',
    'Open URL'
  )
  const leaveToTerminalLabel = translate(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.leaveToTerminalLabel',
    'Leave to terminal'
  )

  return (
    <SearchableSetting
      id={BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID}
      title={title}
      description={description}
      keywords={getTerminalLinkActionSearchKeywords({ isMac })}
    >
      <section className="space-y-3">
        <SettingsSubsectionHeader title={title} description={description} />
        <div className="rounded-lg border border-border/60 bg-muted/10 px-4">
          <div className="divide-y divide-border/40">
            <SettingsRow
              label={plainClickLabel}
              description={plainClickDescription}
              alignTop
              control={
                <SettingsSegmentedControl<TerminalLinkClickBehavior>
                  value={behavior}
                  onChange={(value) => updateSettings({ terminalLinkClickBehavior: value })}
                  ariaLabel={plainClickAriaLabel}
                  size="sm"
                  options={[
                    { value: 'actions', label: actionsLabel },
                    { value: 'open', label: openUrlLabel },
                    { value: 'none', label: leaveToTerminalLabel }
                  ]}
                />
              }
            />
            <SettingsRow
              label={middleClickLabel}
              description={middleClickDescription}
              control={
                <SettingsSegmentedControl<TerminalLinkClickBehavior>
                  value={settings.terminalUrlMiddleClickBehavior ?? 'open'}
                  onChange={(value) => updateSettings({ terminalUrlMiddleClickBehavior: value })}
                  ariaLabel={middleClickAriaLabel}
                  size="sm"
                  options={[
                    { value: 'actions', label: actionsLabel },
                    { value: 'open', label: openUrlLabel },
                    { value: 'none', label: leaveToTerminalLabel }
                  ]}
                />
              }
            />
          </div>
        </div>
      </section>
    </SearchableSetting>
  )
}
