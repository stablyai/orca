import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Separator } from '../ui/separator'
import { Input } from '../ui/input'
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
      keywords: ['shell', 'terminal', 'fish', 'zsh', 'bash', 'nushell', 'default']
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
              updateSettings({ terminalDefaultShell: value === 'system' ? '' : configuredShell })
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
                  updateSettings({ terminalDefaultShell: event.target.value.trimStart() })
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
