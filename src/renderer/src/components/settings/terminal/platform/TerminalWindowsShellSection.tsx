import { useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../../../shared/shell/launch/windows-terminal-shell'
import {
  isWindowsCustomShellPath,
  normalizeTerminalDefaultShell
} from '../../../../../../shared/shell/launch/terminal-default-shell'
import { SettingsRow, SettingsSegmentedControl } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { useTranslate } from '@/i18n/use-translate'
import { ShellIcon } from '../../../terminal/shells/ShellIcon'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { Textarea } from '../../../ui/textarea'
import { TerminalCustomShellInput } from './TerminalCustomShellInput'

type TerminalWindowsShellSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  windowsShell: string
  gitBashAvailable: boolean
  allowCustomShell: boolean
}

function windowsShellLabel(shell: string, label: string): React.JSX.Element {
  return (
    <span className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap">
      <ShellIcon shell={shell} size={12} />
      <span>{label}</span>
    </span>
  )
}

export function TerminalWindowsShellSection({
  settings,
  updateSettings,
  windowsShell,
  gitBashAvailable,
  allowCustomShell
}: TerminalWindowsShellSectionProps): React.JSX.Element {
  const t = useTranslate()
  const pathValidationRequest = useRef(0)
  const [pathValidation, setPathValidation] = useState<{ path: string; error: string } | null>(null)
  const [argsDraft, setArgsDraft] = useState<string | null>(null)
  const custom = allowCustomShell && settings.terminalWindowsUseCustomShell === true
  const customPath = settings.terminalDefaultShell ?? ''
  const pathError =
    pathValidation?.path === normalizeTerminalDefaultShell(customPath)
      ? pathValidation.error
      : undefined
  const validateCustomPath = async (value: string): Promise<void> => {
    const request = ++pathValidationRequest.current
    const path = normalizeTerminalDefaultShell(value)
    let error: string | undefined
    if (path && !isWindowsCustomShellPath(path)) {
      error = t(
        'settings.terminal.windows.customShellAbsolutePath',
        'Enter the full path to a native Windows shell executable (.exe).'
      )
    } else if (path) {
      try {
        if (!(await window.api.shell.pathExists(path))) {
          error = t(
            'auto.components.settings.TerminalPane.5a5eac2f44',
            'Shell not found: {{value0}}',
            {
              value0: path
            }
          )
        }
      } catch {
        error = t(
          'settings.terminal.windows.customShellValidationFailed',
          'Could not verify the shell path. Try again.'
        )
      }
    }
    if (request === pathValidationRequest.current) {
      setPathValidation(error ? { path, error } : null)
    }
  }
  const showGitBashOption = gitBashAvailable || windowsShell === WINDOWS_GIT_BASH_SHELL
  // New WSL choices need a distro; retain only existing WSL defaults here.
  const showWslOption = windowsShell === 'wsl.exe'

  return (
    <SettingsGroup
      key="windows-shell"
      title={t('auto.components.settings.TerminalPane.5aab473c7e', 'Windows shell')}
      description={t(
        'auto.components.settings.TerminalPane.a55eee649f',
        'Default shell for new terminal panes on Windows.'
      )}
    >
      <SearchableSetting
        forceVisible
        className="@container"
        title={t('auto.components.settings.TerminalPane.e9c84d0338', 'Default shell')}
        description={t(
          'auto.components.settings.TerminalPane.bd68f3170d',
          'Choose the default shell for new terminal panes on Windows.'
        )}
      >
        <SettingsRow
          className="grid items-stretch @lg:flex @lg:items-center"
          label={t('auto.components.settings.TerminalPane.e9c84d0338', 'Default shell')}
          description={t(
            'auto.components.settings.TerminalPane.09bf02de9a',
            'Shell used when opening a new terminal pane. Takes effect for new terminals.'
          )}
          control={
            <SettingsSegmentedControl
              size="sm"
              equalWidth
              wrap
              ariaLabel={t('auto.components.settings.TerminalPane.e9c84d0338', 'Default shell')}
              value={custom ? 'custom' : windowsShell}
              onChange={(value) => {
                pathValidationRequest.current++
                setPathValidation(null)
                setArgsDraft(null)
                updateSettings(
                  value === 'custom'
                    ? { terminalWindowsUseCustomShell: true }
                    : {
                        terminalWindowsShell: value,
                        ...(allowCustomShell ? { terminalWindowsUseCustomShell: false } : {})
                      }
                )
              }}
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
                  : []),
                ...(allowCustomShell
                  ? [
                      {
                        value: 'custom',
                        label: (
                          <span className="whitespace-nowrap">
                            {t('auto.components.settings.TerminalPane.f51cc79784', 'Custom shell')}
                          </span>
                        )
                      }
                    ]
                  : [])
              ]}
            />
          }
        />
        {custom ? (
          <div className="space-y-3 py-3">
            <div className="space-y-1.5">
              <label htmlFor="windows-custom-shell" className="text-xs font-medium">
                {t('auto.components.settings.TerminalPane.5e06e87730', 'Custom shell executable')}
              </label>
              <TerminalCustomShellInput
                id="windows-custom-shell"
                value={customPath}
                placeholder={t(
                  'settings.terminal.windows.customShellExample',
                  'C:\\msys64\\usr\\bin\\zsh.exe'
                )}
                spellCheck={false}
                onEdit={(path) => {
                  pathValidationRequest.current++
                  setPathValidation(null)
                  updateSettings({ terminalDefaultShell: path })
                }}
                onCommit={(path) => void validateCustomPath(path)}
                aria-invalid={pathError !== undefined}
                aria-describedby={pathError ? 'windows-custom-shell-error' : undefined}
              />
              {pathError ? (
                <p
                  id="windows-custom-shell-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {pathError}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="windows-custom-shell-args" className="text-xs font-medium">
                {t('auto.components.settings.TerminalPane.01c600daff', 'Shell arguments')}
              </label>
              <p id="windows-custom-shell-args-help" className="text-xs text-muted-foreground">
                {t(
                  'auto.components.settings.TerminalPane.578ec79449',
                  'Enter one argument per line. Leave it empty to pass no arguments.'
                )}
              </p>
              <Textarea
                id="windows-custom-shell-args"
                value={argsDraft ?? (settings.terminalDefaultShellArgs ?? []).join('\n')}
                onChange={(event) => {
                  const draft = event.target.value
                  setArgsDraft(draft)
                  updateSettings({ terminalDefaultShellArgs: draft.split('\n').filter(Boolean) })
                }}
                onBlur={() => setArgsDraft(null)}
                className="min-h-20"
                spellCheck={false}
                aria-describedby="windows-custom-shell-args-help"
              />
            </div>
          </div>
        ) : null}
      </SearchableSetting>
    </SettingsGroup>
  )
}
