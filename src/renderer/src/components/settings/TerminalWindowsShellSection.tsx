import type { GlobalSettings } from '../../../../shared/types'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'
import { ShellIcon } from '../tab-bar/shell-icons'

type TerminalWindowsShellSectionProps = {
  updateSettings: (updates: Partial<GlobalSettings>) => void
  windowsShell: string
  gitBashAvailable: boolean
}

function windowsShellLabel(shell: string, label: string): React.JSX.Element {
  return (
    <span className="inline-flex items-center justify-center gap-1.5">
      <ShellIcon shell={shell} size={12} />
      <span>{label}</span>
    </span>
  )
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
                    label: windowsShellLabel(
                      'powershell.exe',
                      translate('auto.components.settings.TerminalPane.eb7fc4d98a', 'PowerShell')
                    ),
                    ariaLabel: translate(
                      'auto.components.settings.TerminalPane.eb7fc4d98a',
                      'PowerShell'
                    )
                  },
                  {
                    value: 'cmd.exe',
                    label: windowsShellLabel(
                      'cmd.exe',
                      translate(
                        'auto.components.settings.TerminalPane.0f1b8669e6',
                        'Command Prompt'
                      )
                    ),
                    ariaLabel: translate(
                      'auto.components.settings.TerminalPane.0f1b8669e6',
                      'Command Prompt'
                    )
                  },
                  ...(showGitBashOption
                    ? [
                        {
                          value: WINDOWS_GIT_BASH_SHELL,
                          label: windowsShellLabel(
                            WINDOWS_GIT_BASH_SHELL,
                            translate(
                              'auto.components.settings.TerminalPane.f61ac77f16',
                              'Git Bash'
                            )
                          ),
                          ariaLabel: translate(
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
