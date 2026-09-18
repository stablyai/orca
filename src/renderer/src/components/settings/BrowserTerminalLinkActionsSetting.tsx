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
              label="Plain click"
              description="Choose whether a left-click shows actions, opens the URL, or leaves it to the terminal. Cmd/Ctrl-click always opens directly."
              alignTop
              control={
                <SettingsSegmentedControl<TerminalLinkClickBehavior>
                  value={behavior}
                  onChange={(value) => updateSettings({ terminalLinkClickBehavior: value })}
                  ariaLabel="Plain click URL behavior"
                  size="sm"
                  options={[
                    { value: 'actions', label: 'Actions' },
                    { value: 'open', label: 'Open URL' },
                    { value: 'none', label: 'Leave to terminal' }
                  ]}
                />
              }
            />
            <SettingsRow
              label="Middle click"
              description="Choose what a mouse-wheel click does on a detected terminal URL."
              control={
                <SettingsSegmentedControl<TerminalLinkClickBehavior>
                  value={settings.terminalUrlMiddleClickBehavior ?? 'open'}
                  onChange={(value) => updateSettings({ terminalUrlMiddleClickBehavior: value })}
                  ariaLabel="Middle click"
                  size="sm"
                  options={[
                    { value: 'actions', label: 'Actions' },
                    { value: 'open', label: 'Open URL' },
                    { value: 'none', label: 'Leave to terminal' }
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
