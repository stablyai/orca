import type { GlobalSettings } from '../../../../shared/types'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { getTerminalRightClickToPasteSearchEntry } from './terminal-windows-search'
import { OSC52_CLIPBOARD_SETTING_ID } from '../terminal-pane/osc52-clipboard-setting-anchor'
import { translate } from '@/i18n/i18n'

type TerminalInteractionSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  searchQuery: string
  isWindows: boolean
}

export function TerminalInteractionSection({
  settings,
  updateSettings,
  searchQuery,
  isWindows
}: TerminalInteractionSectionProps): React.JSX.Element {
  return (
    <section key="pane-interaction" className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalPane.45721f3e67',
          'Terminal Interaction'
        )}
        description={translate(
          'auto.components.settings.TerminalPane.96fe15def8',
          'Mouse and clipboard behavior for terminal panes.'
        )}
      />

      <div className="divide-y divide-border/40">
        {/* Why: the Windows-only right-click toggle lives in this section, so the
            section must also match that search term or settings search would hide
            the control even though it is present. */}
        {isWindows &&
        matchesSettingsSearch(searchQuery, getTerminalRightClickToPasteSearchEntry()) ? (
          <SearchableSetting
            title={translate(
              'auto.components.settings.TerminalPane.9c178cf8aa',
              'Right-click to paste'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.af0c3b6e39',
              'On Windows, right-click pastes the clipboard into the terminal. Use Ctrl+right-click to open the context menu.'
            )}
            keywords={['terminal', 'windows', 'right click', 'paste', 'context menu']}
          >
            <SettingsSwitchRow
              label={translate(
                'auto.components.settings.TerminalPane.9c178cf8aa',
                'Right-click to paste'
              )}
              description={translate(
                'auto.components.settings.TerminalPane.16753eea48',
                'On Windows, right-click pastes the clipboard. Ctrl+right-click opens the context menu.'
              )}
              checked={settings.terminalRightClickToPaste}
              onChange={() =>
                updateSettings({
                  terminalRightClickToPaste: !settings.terminalRightClickToPaste
                })
              }
            />
          </SearchableSetting>
        ) : null}

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalPane.8eefeaa3da',
            'Focus Follows Mouse'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.9129b7e805',
            'Hovering a terminal pane activates it without needing to click.'
          )}
          keywords={['focus', 'follows', 'mouse', 'hover', 'pane', 'ghostty', 'active']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalPane.8eefeaa3da',
              'Focus Follows Mouse'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.9129b7e805',
              'Hovering a terminal pane activates it without needing to click.'
            )}
            checked={settings.terminalFocusFollowsMouse}
            onChange={() =>
              updateSettings({
                terminalFocusFollowsMouse: !settings.terminalFocusFollowsMouse
              })
            }
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate('auto.components.settings.TerminalPane.902f5dee1f', 'Copy on Select')}
          description={translate(
            'auto.components.settings.TerminalPane.4729c645fc',
            'Automatically copy terminal selections to the clipboard.'
          )}
          keywords={[
            'clipboard',
            'copy',
            'select',
            'selection',
            'auto',
            'automatic',
            'x11',
            'linux',
            'gnome',
            'paste'
          ]}
        >
          <SettingsSwitchRow
            label={translate('auto.components.settings.TerminalPane.902f5dee1f', 'Copy on Select')}
            description={translate(
              'auto.components.settings.TerminalPane.4729c645fc',
              'Automatically copy terminal selections to the clipboard.'
            )}
            checked={settings.terminalClipboardOnSelect}
            onChange={() =>
              updateSettings({
                terminalClipboardOnSelect: !settings.terminalClipboardOnSelect
              })
            }
          />
        </SearchableSetting>

        <SearchableSetting
          id={OSC52_CLIPBOARD_SETTING_ID}
          title={translate(
            'auto.components.settings.TerminalPane.3338dcf8c1',
            'Allow TUI Clipboard Writes (OSC 52)'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.69c64a479c',
            'Let tmux, Neovim, and fzf copy to the system clipboard over the PTY (including over SSH).'
          )}
          keywords={[
            'osc 52',
            'osc52',
            'clipboard',
            'tmux',
            'neovim',
            'nvim',
            'fzf',
            'ssh',
            'remote',
            'copy',
            'paste'
          ]}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalPane.3338dcf8c1',
              'Allow TUI Clipboard Writes (OSC 52)'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.6e6480a7df',
              'Let programs in the terminal (tmux, Neovim, fzf, SSH) copy to your system clipboard.'
            )}
            checked={settings.terminalAllowOsc52Clipboard}
            onChange={() =>
              updateSettings({
                terminalAllowOsc52Clipboard: !settings.terminalAllowOsc52Clipboard
              })
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
