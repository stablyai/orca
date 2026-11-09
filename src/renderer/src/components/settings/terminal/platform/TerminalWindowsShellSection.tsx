import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../../../shared/windows-terminal-shell'
import { SettingsRow, SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'
import { ShellIcon } from '../../../tab-bar/shell-icons'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

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
  const t = useTranslate()
  const showGitBashOption = gitBashAvailable || windowsShell === WINDOWS_GIT_BASH_SHELL
  // New WSL choices need a distro; retain only existing WSL defaults here.
  const showWslOption = windowsShell === 'wsl.exe'

  return (
    <SettingsGroup
      key="windows-shell"
      title={t('auto.components.settings.TerminalPane.87e678a8af', 'Windows Shell')}
      description={t(
        'auto.components.settings.TerminalPane.a55eee649f',
        'Default shell for new terminal panes on Windows.'
      )}
    >
      <SearchableSetting
        className="@container"
        title={t('auto.components.settings.TerminalPane.27e301f22c', 'Default Shell')}
        description={t(
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
          className="flex-col items-stretch @lg:flex-row @lg:items-center"
          label={t('auto.components.settings.TerminalPane.27e301f22c', 'Default Shell')}
          description={t(
            'auto.components.settings.TerminalPane.09bf02de9a',
            'Shell used when opening a new terminal pane. Takes effect for new terminals.'
          )}
          control={
            <SettingsSegmentedControl
              size="sm"
              equalWidth
              wrap
              ariaLabel={t('auto.components.settings.TerminalPane.27e301f22c', 'Default Shell')}
              value={windowsShell}
              onChange={(value) => updateSettings({ terminalWindowsShell: value })}
              options={[
                {
                  value: 'powershell.exe',
                  label: windowsShellLabel(
                    'powershell.exe',
                    t('auto.components.settings.TerminalPane.eb7fc4d98a', 'PowerShell')
                  ),
                  ariaLabel: t('auto.components.settings.TerminalPane.eb7fc4d98a', 'PowerShell')
                },
                {
                  value: 'cmd.exe',
                  label: windowsShellLabel(
                    'cmd.exe',
                    t('auto.components.settings.TerminalPane.0f1b8669e6', 'Command Prompt')
                  ),
                  ariaLabel: t('auto.components.settings.TerminalPane.0f1b8669e6', 'Command Prompt')
                },
                ...(showGitBashOption
                  ? [
                      {
                        value: WINDOWS_GIT_BASH_SHELL,
                        label: windowsShellLabel(
                          WINDOWS_GIT_BASH_SHELL,
                          t('auto.components.settings.TerminalPane.f61ac77f16', 'Git Bash')
                        ),
                        ariaLabel: t(
                          'auto.components.settings.TerminalPane.f61ac77f16',
                          'Git Bash'
                        ),
                        disabled: !gitBashAvailable
                      }
                    ]
                  : []),
                ...(showWslOption
                  ? [
                      {
                        value: 'wsl.exe',
                        label: windowsShellLabel(
                          'wsl.exe',
                          t('auto.components.settings.TerminalPane.b637dd57a7', 'WSL')
                        ),
                        ariaLabel: t('auto.components.settings.TerminalPane.b637dd57a7', 'WSL'),
                        disabled: true
                      }
                    ]
                  : [])
              ]}
            />
          }
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}
