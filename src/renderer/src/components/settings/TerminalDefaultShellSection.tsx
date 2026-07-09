import { useEffect, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  isAbsoluteTerminalShellPath,
  normalizeTerminalDefaultShellPath,
  type TerminalDefaultShellValidationCode
} from '../../../../shared/terminal-default-shell'
import { Input } from '../ui/input'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type TerminalDefaultShellSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

type TerminalDefaultShellMode = 'system' | 'custom'

const SHELL_PATH_INPUT_ID = 'terminal-default-shell-path'
const SHELL_PATH_MESSAGE_ID = 'terminal-default-shell-path-message'

function getValidationMessage(code: TerminalDefaultShellValidationCode, shellPath: string): string {
  switch (code) {
    case 'not-posix-absolute':
      return translate(
        'auto.components.settings.TerminalDefaultShellSection.d2ad34c1f6',
        'Use a POSIX absolute path, such as /bin/zsh or /usr/bin/fish.'
      )
    case 'not-found':
      return translate(
        'auto.components.settings.TerminalDefaultShellSection.95cca730e4',
        'Shell "{{value0}}" does not exist.',
        { value0: shellPath }
      )
    case 'not-file':
      return translate(
        'auto.components.settings.TerminalDefaultShellSection.d96c7331bb',
        'Shell "{{value0}}" is not a file.',
        { value0: shellPath }
      )
    case 'not-executable':
      return translate(
        'auto.components.settings.TerminalDefaultShellSection.6334403ed7',
        'Shell "{{value0}}" is not executable.',
        { value0: shellPath }
      )
    case 'not-recognized-shell':
      return translate(
        'auto.components.settings.TerminalDefaultShellSection.ffcf81d40f',
        'Shell "{{value0}}" is not recognized. Choose bash, zsh, fish, sh, ksh, dash, tcsh, csh, or a path listed in /etc/shells.',
        { value0: shellPath }
      )
    case 'unsupported-platform':
      return translate(
        'auto.components.settings.TerminalDefaultShellSection.26d742c733',
        'Custom POSIX default shells are only supported on macOS and Linux.'
      )
    default:
      return translate(
        'auto.components.settings.TerminalDefaultShellSection.28b50d850b',
        'Shell "{{value0}}" is not valid.',
        { value0: shellPath }
      )
  }
}

export function TerminalDefaultShellSection({
  settings,
  updateSettings
}: TerminalDefaultShellSectionProps): React.JSX.Element {
  const persistedShell = settings.terminalDefaultShellPath ?? ''
  const [mode, setMode] = useState<TerminalDefaultShellMode>(persistedShell ? 'custom' : 'system')
  const [draftShell, setDraftShell] = useState(persistedShell)
  const [validationMessage, setValidationMessage] = useState<string | null>(null)
  const validationRequestIdRef = useRef(0)
  const trimmedDraftShell = draftShell.trim()
  const shellPathInvalid =
    mode === 'custom' &&
    trimmedDraftShell.length > 0 &&
    !isAbsoluteTerminalShellPath(trimmedDraftShell)
  const shellPathMessage =
    shellPathInvalid || !validationMessage
      ? translate(
          'auto.components.settings.TerminalDefaultShellSection.d2ad34c1f6',
          'Use a POSIX absolute path, such as /bin/zsh or /usr/bin/fish.'
        )
      : validationMessage
  const shellPathHasError = shellPathInvalid || validationMessage !== null

  useEffect(() => {
    validationRequestIdRef.current += 1
    setDraftShell(persistedShell)
    setMode(persistedShell ? 'custom' : 'system')
    setValidationMessage(null)
  }, [persistedShell])

  const commitDraftShell = async (): Promise<void> => {
    if (shellPathInvalid) {
      return
    }
    const requestId = ++validationRequestIdRef.current
    const normalizedShell = normalizeTerminalDefaultShellPath(draftShell)
    if (normalizedShell) {
      const validation = await window.api.settings.validateTerminalDefaultShellPath(normalizedShell)
      if (validationRequestIdRef.current !== requestId) {
        return
      }
      if (!validation.ok) {
        setValidationMessage(getValidationMessage(validation.code, normalizedShell))
        return
      }
    }
    if (validationRequestIdRef.current !== requestId) {
      return
    }
    setValidationMessage(null)
    updateSettings({
      terminalDefaultShellPath: normalizedShell
    })
  }

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalDefaultShellSection.ee7cb911e8',
          'Local Shell'
        )}
        description={translate(
          'auto.components.settings.TerminalDefaultShellSection.67a5341565',
          'Default shell for new local macOS and Linux terminal panes.'
        )}
      />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalDefaultShellSection.e52e156b21',
            'Default Shell'
          )}
          description={translate(
            'auto.components.settings.TerminalDefaultShellSection.771784d945',
            'Choose the shell Orca opens for new local macOS and Linux terminal panes.'
          )}
          keywords={[
            'terminal',
            'shell',
            'default',
            'zsh',
            'bash',
            'fish',
            'macos',
            'linux',
            'local'
          ]}
        >
          <SettingsRow
            alignTop
            label={translate(
              'auto.components.settings.TerminalDefaultShellSection.e52e156b21',
              'Default Shell'
            )}
            description={translate(
              'auto.components.settings.TerminalDefaultShellSection.80099ab61e',
              'Takes effect for new local terminals. Existing panes keep the shell they already launched.'
            )}
            control={
              <div className="flex w-64 flex-col items-stretch gap-2">
                <SettingsSegmentedControl<TerminalDefaultShellMode>
                  ariaLabel={translate(
                    'auto.components.settings.TerminalDefaultShellSection.e52e156b21',
                    'Default Shell'
                  )}
                  value={mode}
                  onChange={(nextMode) => {
                    validationRequestIdRef.current += 1
                    setMode(nextMode)
                    setValidationMessage(null)
                    if (nextMode === 'system') {
                      setDraftShell('')
                      updateSettings({ terminalDefaultShellPath: null })
                    }
                  }}
                  equalWidth
                  options={[
                    {
                      value: 'system',
                      label: translate(
                        'auto.components.settings.TerminalDefaultShellSection.d884efa6ee',
                        'System'
                      )
                    },
                    {
                      value: 'custom',
                      label: translate(
                        'auto.components.settings.TerminalDefaultShellSection.981c472a7d',
                        'Custom'
                      )
                    }
                  ]}
                />
                {mode === 'custom' ? (
                  <div className="space-y-1">
                    <Input
                      id={SHELL_PATH_INPUT_ID}
                      value={draftShell}
                      onChange={(event) => {
                        validationRequestIdRef.current += 1
                        setDraftShell(event.target.value)
                        setValidationMessage(null)
                      }}
                      onBlur={() => void commitDraftShell()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          void commitDraftShell()
                          event.currentTarget.blur()
                        }
                      }}
                      aria-invalid={shellPathHasError}
                      aria-describedby={SHELL_PATH_MESSAGE_ID}
                      placeholder="/bin/zsh"
                      className="font-mono text-xs"
                    />
                    <p
                      id={SHELL_PATH_MESSAGE_ID}
                      className={
                        shellPathHasError
                          ? 'text-[11px] text-destructive'
                          : 'text-[11px] text-muted-foreground'
                      }
                    >
                      {shellPathMessage}
                    </p>
                  </div>
                ) : null}
              </div>
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
