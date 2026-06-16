import type { GlobalSettings } from '../../../../shared/types'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type TerminalWindowsShellSectionProps = {
  updateSettings: (updates: Partial<GlobalSettings>) => void
  windowsShell: string
  gitBashAvailable: boolean
}

export function TerminalWindowsShellSection({
  updateSettings,
  windowsShell,
  gitBashAvailable
}: TerminalWindowsShellSectionProps): React.JSX.Element {
  const showGitBashOption = gitBashAvailable || windowsShell === WINDOWS_GIT_BASH_SHELL

  return (
    <section key="windows-shell" className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.TerminalPane.87e678a8af', 'Windows Shell')}
        description={translate(
          'auto.components.settings.TerminalPane.a55eee649f',
          'Default shell for new terminal panes on Windows.'
        )}
      />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title={translate('auto.components.settings.TerminalPane.27e301f22c', 'Default Shell')}
          description={translate(
            'auto.components.settings.TerminalPane.bd68f3170d',
            'Choose the default shell for new terminal panes on Windows.'
          )}
          keywords={[
            'terminal',
            'windows',
            'shell',
            'powershell',
            'cmd',
            'command prompt',
            'git bash',
            'bash.exe',
            'default'
          ]}
        >
          <SettingsRow
            label={translate('auto.components.settings.TerminalPane.27e301f22c', 'Default Shell')}
            description={translate(
              'auto.components.settings.TerminalPane.09bf02de9a',
              'Shell used when opening a new terminal pane. Takes effect for new terminals.'
            )}
            control={
              <SettingsSegmentedControl
                ariaLabel={translate(
                  'auto.components.settings.TerminalPane.27e301f22c',
                  'Default Shell'
                )}
                value={windowsShell}
                onChange={(value) => updateSettings({ terminalWindowsShell: value })}
                options={[
                  {
                    value: 'powershell.exe',
                    label: translate(
                      'auto.components.settings.TerminalPane.eb7fc4d98a',
                      'PowerShell'
                    )
                  },
                  {
                    value: 'cmd.exe',
                    label: translate(
                      'auto.components.settings.TerminalPane.0f1b8669e6',
                      'Command Prompt'
                    )
                  },
                  ...(showGitBashOption
                    ? [
                        {
                          value: WINDOWS_GIT_BASH_SHELL,
                          label: translate(
                            'auto.components.settings.TerminalPane.f61ac77f16',
                            'Git Bash'
                          ),
                          disabled: !gitBashAvailable
                        }
                      ]
                    : [])
                ]}
              />
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
