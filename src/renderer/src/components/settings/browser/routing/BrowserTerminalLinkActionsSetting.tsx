import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { getTerminalLinkActionSearchKeywords } from './browser-terminal-link-action-search'
import {
  terminalLinkClickBehaviorFor,
  type TerminalLinkClickBehavior
} from '../../../terminal-pane/links/gestures/terminal-link-click-behavior'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

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
  const t = useTranslate()
  const title = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.title',
    'Terminal URL clicks'
  )
  const description = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.descriptionV2',
    'Control clicks on detected URLs printed in terminal panes and chat transcripts.'
  )
  const behavior = terminalLinkClickBehaviorFor(settings)
  const plainClickLabel = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.plainClickLabel',
    'Plain click'
  )
  const plainClickDescription = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.plainClickDescription',
    'Choose whether a left-click shows actions, opens the URL, or leaves it to the terminal. Cmd/Ctrl-click always opens directly.'
  )
  const plainClickAriaLabel = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.plainClickAriaLabel',
    'Plain click URL behavior'
  )
  const middleClickLabel = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.middleClickLabel',
    'Middle click'
  )
  const middleClickDescription = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.middleClickDescription',
    'Choose what a mouse-wheel click does on a detected terminal URL.'
  )
  const middleClickAriaLabel = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.middleClickAriaLabel',
    'Middle click'
  )
  const actionsLabel = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.actionsLabel',
    'Actions'
  )
  const openUrlLabel = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.openUrlLabel',
    'Open URL'
  )
  const leaveToTerminalLabel = t(
    'auto.components.settings.BrowserTerminalLinkActionsSetting.leaveToTerminalLabel',
    'Leave to terminal'
  )

  return (
    <SearchableSetting
      id={BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID}
      title={title}
      description={description}
      keywords={getTerminalLinkActionSearchKeywords({ isMac }, t)}
    >
      <SettingsGroup title={title} description={description}>
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
      </SettingsGroup>
    </SearchableSetting>
  )
}
