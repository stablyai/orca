import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Separator } from '../ui/separator'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { cn } from '@/lib/utils'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import {
  getManageSessionsSearchEntries,
  getTerminalAdvancedSearchEntries,
  getTerminalMacOptionSearchEntries,
  getTerminalMacYenSearchEntries,
  getTerminalPaneInteractionSearchEntries,
  getTerminalRenderingSearchEntries,
  getTerminalSetupScriptSearchEntries
} from './terminal-search'
import {
  getTerminalRightClickToPasteSearchEntry,
  getTerminalWindowsPowershellImplementationSearchEntry,
  getTerminalWindowsShellSearchEntry
} from './terminal-windows-search'
import { ManageSessionsSection } from './ManageSessionsSection'
import { TerminalAdvancedSection } from './TerminalAdvancedSection'
import { TerminalInteractionSection } from './TerminalInteractionSection'
import { TerminalRenderingSection } from './TerminalRenderingSection'
import { TerminalSetupScriptSection } from './TerminalSetupScriptSection'
import { TerminalWindowsShellSection } from './TerminalWindowsShellSection'
import { SettingsSegmentedControl, SettingsSubsectionHeader } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

type TerminalPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  scrollbackMode: 'preset' | 'custom'
  setScrollbackMode: (mode: 'preset' | 'custom') => void
  /** Deprecated: WSL selection now belongs to Project Runtime settings. */
  wslAvailable?: boolean
  /** Deprecated: WSL selection now belongs to Project Runtime settings. */
  wslDistros?: string[]
  /** Deprecated: WSL selection now belongs to Project Runtime settings. */
  wslCapabilitiesLoading?: boolean
  /** Whether PowerShell 7+ (pwsh.exe) is installed on this Windows machine. */
  pwshAvailable?: boolean
  /** Whether Git for Windows bash.exe is installed on this machine. */
  gitBashAvailable?: boolean
  /** Whether the active terminal host is Windows, even if the client is not. */
  isWindowsTerminalHost?: boolean
}

export function TerminalPane({
  settings,
  updateSettings,
  scrollbackMode,
  setScrollbackMode,
  pwshAvailable,
  gitBashAvailable = false,
  isWindowsTerminalHost
}: TerminalPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isWindows = isWindowsUserAgent()
  const showWindowsHostSettings = isWindowsTerminalHost ?? isWindows
  const isMac = isMacUserAgent()
  const windowsShell = settings.terminalWindowsShell ?? 'powershell.exe'
  const showWindowsPowerShellImplementation =
    showWindowsHostSettings && windowsShell === 'powershell.exe'

  const [shellValidationError, setShellValidationError] = useState<string | null>(null)
  const configuredShell = settings.terminalDefaultShell?.trim() ?? ''
  const shellMode = configuredShell ? 'custom' : 'system'
  const configuredShellArgs = settings.terminalDefaultShellArgs ?? []
  const [customShellArgs, setCustomShellArgs] = useState(configuredShellArgs)
  const [shellArgsOpen, setShellArgsOpen] = useState(configuredShellArgs.length > 0)
  const [shellArgsMode, setShellArgsMode] = useState<'default' | 'custom'>(
    settings.terminalDefaultShellArgs === undefined ? 'default' : 'custom'
  )
  const systemShell =
    (typeof window !== 'undefined' ? window.api?.platform?.get?.().shell?.trim() : '') || '/bin/zsh'

  const validateShell = async (): Promise<void> => {
    const shell = configuredShell
    const isAbsolute = shell.startsWith('/') || /^[A-Za-z]:[\\/]/.test(shell)
    if (!isAbsolute) {
      setShellValidationError(null)
      return
    }
    const exists = await window.api.shell.pathExists(shell)
    setShellValidationError(
      exists
        ? null
        : translate(
            'auto.components.settings.TerminalPane.5a5eac2f44',
            'Shell not found: {{value0}}',
            {
              value0: shell
            }
          )
    )
  }

  const defaultShellSection =
    !showWindowsHostSettings &&
    matchesSettingsSearch(searchQuery, {
      title: translate('auto.components.settings.TerminalPane.9589abc009', 'Default shell'),
      description: translate(
        'auto.components.settings.TerminalPane.1c29734248',
        'Shell used for new terminal panes'
      ),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.TerminalPane.a909136b3f', 'shell'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.81694f1584', 'terminal'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.0cbe5ad727', 'fish'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.c9bc93d343', 'zsh'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.17ad899ba4', 'bash'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.d469840b75', 'nushell'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.ddc72a4860', 'default'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.af893aa433', 'arguments'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.44f8a56f66', 'args'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.4faf688f78', 'login'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.73c211e979', 'wrapper'),
        ...translateSearchKeyword('auto.components.settings.TerminalPane.c2ddb189e7', 'rcfile')
      ]
    }) ? (
      <section key="default-shell" className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.TerminalPane.fd05fb109c', 'Terminal shell')}
          description={translate(
            'auto.components.settings.TerminalPane.69724e8f0c',
            'Choose what Orca opens for new local terminal panes.'
          )}
        />
        <div className="space-y-3">
          <SettingsSegmentedControl
            ariaLabel={translate(
              'auto.components.settings.TerminalPane.fd05fb109c',
              'Terminal shell'
            )}
            value={shellMode}
            onChange={(value) => {
              setShellValidationError(null)
              if (value === 'system') {
                setShellArgsMode('default')
              }
              updateSettings(
                value === 'system'
                  ? { terminalDefaultShell: '', terminalDefaultShellArgs: undefined }
                  : { terminalDefaultShell: configuredShell || systemShell }
              )
            }}
            options={[
              {
                value: 'system',
                label: translate(
                  'auto.components.settings.TerminalPane.dd3f4c35da',
                  'System shell ({{value0}})',
                  { value0: systemShell }
                )
              },
              {
                value: 'custom',
                label: translate('auto.components.settings.TerminalPane.f51cc79784', 'Custom shell')
              }
            ]}
          />
          {shellMode === 'custom' ? (
            <div className="space-y-1.5">
              <Input
                value={settings.terminalDefaultShell ?? ''}
                placeholder={translate(
                  'auto.components.settings.TerminalPane.c2bf02ce2f',
                  'fish, nu, or /bin/zsh'
                )}
                onChange={(event) => {
                  setShellValidationError(null)
                  updateSettings({ terminalDefaultShell: event.target.value.trimStart() })
                }}
                onBlur={() => void validateShell()}
                className="w-full"
                aria-label={translate(
                  'auto.components.settings.TerminalPane.5e06e87730',
                  'Custom shell executable'
                )}
                aria-invalid={shellValidationError != null}
                aria-describedby={shellValidationError ? 'default-shell-error' : undefined}
              />
              <p id="default-shell-help" className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.TerminalPane.59573d0b33',
                  'Enter a shell name on PATH or an executable path. Orca starts it as a login shell.'
                )}
              </p>
              {shellValidationError ? (
                <p id="default-shell-error" role="alert" className="text-xs text-destructive">
                  {shellValidationError}
                  {translate(
                    'auto.components.settings.TerminalPane.e3ae5aed18',
                    '. Switch to System shell or choose an executable on this host.'
                  )}
                </p>
              ) : null}
              <Collapsible open={shellArgsOpen} onOpenChange={setShellArgsOpen}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    aria-controls="default-shell-args-content"
                  >
                    {translate('auto.components.settings.TerminalPane.5e5f06c82c', 'Advanced')}
                    <ChevronDown
                      className={cn('size-3.5 transition-transform', shellArgsOpen && 'rotate-180')}
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent id="default-shell-args-content">
                  <div className="mt-1.5 space-y-2 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
                    <div className="space-y-1">
                      <label htmlFor="default-shell-args" className="text-xs font-medium">
                        {translate(
                          'auto.components.settings.TerminalPane.01c600daff',
                          'Shell arguments'
                        )}
                      </label>
                      <p className="text-xs text-muted-foreground">
                        {shellArgsMode === 'default'
                          ? translate(
                              'auto.components.settings.TerminalPane.884a006065',
                              'Starts the shell as a login shell with -l.'
                            )
                          : translate(
                              'auto.components.settings.TerminalPane.578ec79449',
                              'Enter one argument per line. Leave it empty to pass no arguments.'
                            )}
                      </p>
                    </div>
                    <SettingsSegmentedControl
                      ariaLabel={translate(
                        'auto.components.settings.TerminalPane.5ffc4777b6',
                        'Shell argument mode'
                      )}
                      value={shellArgsMode}
                      onChange={(value) => {
                        setShellArgsMode(value)
                        updateSettings({
                          terminalDefaultShellArgs:
                            value === 'default' ? undefined : customShellArgs
                        })
                      }}
                      options={[
                        {
                          value: 'default',
                          label: translate(
                            'auto.components.settings.TerminalPane.7bd83fc1d0',
                            '-l (default)'
                          )
                        },
                        {
                          value: 'custom',
                          label: translate(
                            'auto.components.settings.TerminalPane.48b91a3ed2',
                            'Custom args'
                          )
                        }
                      ]}
                    />
                    {shellArgsMode === 'custom' ? (
                      <Textarea
                        id="default-shell-args"
                        value={customShellArgs.join('\n')}
                        onChange={(event) => {
                          const nextArgs = event.target.value
                            .split('\n')
                            .filter((argument) => argument.length > 0)
                          setCustomShellArgs(nextArgs)
                          updateSettings({ terminalDefaultShellArgs: nextArgs })
                        }}
                        placeholder={translate(
                          'auto.components.settings.TerminalPane.f58cb71f53',
                          '--rcfile\n/path/to/rcfile'
                        )}
                        className="min-h-20"
                        spellCheck={false}
                        aria-label={translate(
                          'auto.components.settings.TerminalPane.8dbe0bc942',
                          'Shell arguments, one per line'
                        )}
                      />
                    ) : null}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          ) : null}
        </div>
      </section>
    ) : null

  const visibleSections = [
    defaultShellSection,
    showWindowsHostSettings &&
    matchesSettingsSearch(searchQuery, getTerminalWindowsShellSearchEntry()) ? (
      <TerminalWindowsShellSection
        key="windows-shell"
        updateSettings={updateSettings}
        windowsShell={windowsShell}
        gitBashAvailable={gitBashAvailable}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalRenderingSearchEntries()) ? (
      <TerminalRenderingSection
        key="rendering"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalPaneInteractionSearchEntries()) ||
    matchesSettingsSearch(searchQuery, getTerminalRightClickToPasteSearchEntry()) ? (
      <TerminalInteractionSection
        key="pane-interaction"
        settings={settings}
        updateSettings={updateSettings}
        searchQuery={searchQuery}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalSetupScriptSearchEntries()) ? (
      <TerminalSetupScriptSection
        key="setup-script"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getManageSessionsSearchEntries()) ? (
      <ManageSessionsSection key="manage-sessions" />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalAdvancedSearchEntries()) ||
    (showWindowsPowerShellImplementation &&
      matchesSettingsSearch(
        searchQuery,
        getTerminalWindowsPowershellImplementationSearchEntry()
      )) ||
    (isMac &&
      (matchesSettingsSearch(searchQuery, getTerminalMacOptionSearchEntries()) ||
        matchesSettingsSearch(searchQuery, getTerminalMacYenSearchEntries()))) ? (
      <TerminalAdvancedSection
        key="advanced"
        settings={settings}
        updateSettings={updateSettings}
        scrollbackMode={scrollbackMode}
        setScrollbackMode={setScrollbackMode}
        searchQuery={searchQuery}
        showWindowsPowerShellImplementation={showWindowsPowerShellImplementation}
        pwshAvailable={pwshAvailable}
        isMac={isMac}
      />
    ) : null
  ].filter(Boolean)

  return (
    <div className="space-y-6">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-6">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
