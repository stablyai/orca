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
  cmderAvailable?: boolean
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
  cmderAvailable = false,
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
    setShellValidationError(exists ? null : `Shell not found: ${shell}`)
  }

  const defaultShellSection =
    !showWindowsHostSettings &&
    matchesSettingsSearch(searchQuery, {
      title: 'Default shell',
      description: 'Shell used for new terminal panes',
      keywords: [
        'shell',
        'terminal',
        'fish',
        'zsh',
        'bash',
        'nushell',
        'default',
        'arguments',
        'args',
        'login',
        'wrapper',
        'rcfile'
      ]
    }) ? (
      <section key="default-shell" className="space-y-3">
        <SettingsSubsectionHeader
          title="Terminal shell"
          description="Choose what Orca opens for new local terminal panes."
        />
        <div className="space-y-3">
          <SettingsSegmentedControl
            ariaLabel="Terminal shell"
            value={shellMode}
            onChange={(value) => {
              setShellValidationError(null)
              if (value === 'system') {
                setShellArgsMode('default')
              }
              updateSettings(
                value === 'system'
                  ? {
                      terminalDefaultShell: '',
                      terminalDefaultShellArgs: undefined
                    }
                  : { terminalDefaultShell: configuredShell || systemShell }
              )
            }}
            options={[
              { value: 'system', label: `System shell (${systemShell})` },
              { value: 'custom', label: 'Custom shell' }
            ]}
          />
          {shellMode === 'custom' ? (
            <div className="space-y-1.5">
              <Input
                value={settings.terminalDefaultShell ?? ''}
                placeholder="fish, nu, or /bin/zsh"
                onChange={(event) => {
                  setShellValidationError(null)
                  updateSettings({
                    terminalDefaultShell: event.target.value.trimStart()
                  })
                }}
                onBlur={() => void validateShell()}
                className="w-full"
                aria-label="Custom shell executable"
                aria-invalid={shellValidationError != null}
                aria-describedby={shellValidationError ? 'default-shell-error' : undefined}
              />
              <p id="default-shell-help" className="text-xs text-muted-foreground">
                Enter a shell name on PATH or an executable path. Orca starts it as a login shell.
              </p>
              {shellValidationError ? (
                <p id="default-shell-error" role="alert" className="text-xs text-destructive">
                  {shellValidationError}. Switch to System shell or choose an executable on this
                  host.
                </p>
              ) : null}
              <Collapsible open={shellArgsOpen} onOpenChange={setShellArgsOpen}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-7 items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    aria-controls="default-shell-args-content"
                  >
                    Advanced
                    <ChevronDown
                      className={cn('size-3.5 transition-transform', shellArgsOpen && 'rotate-180')}
                    />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent id="default-shell-args-content">
                  <div className="mt-1.5 space-y-2 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
                    <div className="space-y-1">
                      <label htmlFor="default-shell-args" className="text-xs font-medium">
                        Shell arguments
                      </label>
                      <p className="text-xs text-muted-foreground">
                        {shellArgsMode === 'default'
                          ? 'Starts the shell as a login shell with -l.'
                          : 'Enter one argument per line. Leave it empty to pass no arguments.'}
                      </p>
                    </div>
                    <SettingsSegmentedControl
                      ariaLabel="Shell argument mode"
                      value={shellArgsMode}
                      onChange={(value) => {
                        setShellArgsMode(value)
                        updateSettings({
                          terminalDefaultShellArgs:
                            value === 'default' ? undefined : customShellArgs
                        })
                      }}
                      options={[
                        { value: 'default', label: '-l (default)' },
                        { value: 'custom', label: 'Custom args' }
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
                          updateSettings({
                            terminalDefaultShellArgs: nextArgs
                          })
                        }}
                        placeholder={'--rcfile\n/path/to/rcfile'}
                        className="min-h-20"
                        spellCheck={false}
                        aria-label="Shell arguments, one per line"
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
        cmderAvailable={cmderAvailable}
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
