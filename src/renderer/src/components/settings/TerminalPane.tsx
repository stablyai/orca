/* eslint-disable max-lines -- Why: TerminalPane keeps terminal workflow, runtime, and recovery
   settings together so search shows one focused terminal behavior surface. */
import type { GlobalSettings, SetupScriptLaunchMode } from '../../../../shared/types'
import { Input } from '../ui/input'
import { Separator } from '../ui/separator'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { clampNumber } from '@/lib/terminal-theme'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { SCROLLBACK_PRESETS_MB } from './SettingsConstants'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import {
  MANAGE_SESSIONS_SEARCH_ENTRIES,
  TERMINAL_ADVANCED_SEARCH_ENTRIES,
  TERMINAL_MAC_OPTION_SEARCH_ENTRIES,
  TERMINAL_MAC_YEN_SEARCH_ENTRIES,
  TERMINAL_PANE_INTERACTION_SEARCH_ENTRIES,
  TERMINAL_RENDERING_SEARCH_ENTRIES,
  TERMINAL_SETUP_SCRIPT_SEARCH_ENTRIES
} from './terminal-search'
import {
  TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY,
  TERMINAL_WINDOWS_POWERSHELL_IMPLEMENTATION_SEARCH_ENTRY,
  TERMINAL_WINDOWS_SHELL_SEARCH_ENTRY
} from './terminal-windows-search'
import { useDetectedOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { ManageSessionsSection } from './ManageSessionsSection'
import { OSC52_CLIPBOARD_SETTING_ID } from '../terminal-pane/osc52-clipboard-setting-anchor'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'

type TerminalPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  scrollbackMode: 'preset' | 'custom'
  setScrollbackMode: (mode: 'preset' | 'custom') => void
  /** Whether WSL is installed on this Windows machine. */
  wslAvailable?: boolean
  /** Installed WSL distro names, used to choose the default WSL terminal target. */
  wslDistros?: string[]
  /** Whether WSL capability probing is still in flight. */
  wslCapabilitiesLoading?: boolean
  /** Whether PowerShell 7+ (pwsh.exe) is installed on this Windows machine. */
  pwshAvailable?: boolean
  /** Whether Git for Windows bash.exe is installed on this machine. */
  gitBashAvailable?: boolean
}

export function TerminalPane({
  settings,
  updateSettings,
  scrollbackMode,
  setScrollbackMode,
  wslAvailable,
  wslDistros = [],
  wslCapabilitiesLoading = false,
  pwshAvailable,
  gitBashAvailable = false
}: TerminalPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isWindows = isWindowsUserAgent()
  const isMac = isMacUserAgent()
  const detectedLayout = useDetectedOptionAsAlt()
  const detectedLayoutLabel =
    detectedLayout === 'us'
      ? 'US English — Option sends Alt/Esc sequences'
      : detectedLayout === 'non-us'
        ? 'non-US layout — Option composes characters like @, €, [, ]'
        : 'unknown layout — Option composes characters (safe default)'
  const scrollbackMb = Math.max(1, Math.round(settings.terminalScrollbackBytes / 1_000_000))
  const isPreset = SCROLLBACK_PRESETS_MB.includes(
    scrollbackMb as (typeof SCROLLBACK_PRESETS_MB)[number]
  )
  const scrollbackToggleValue =
    scrollbackMode === 'custom' ? 'custom' : isPreset ? `${scrollbackMb}` : 'custom'
  const windowsShell = settings.terminalWindowsShell ?? 'powershell.exe'
  const selectedWslDistroName = settings.terminalWindowsWslDistro?.trim() || null
  const selectedWslDistro = selectedWslDistroName || '__default__'
  const wslDistroOptions =
    selectedWslDistroName && !wslDistros.includes(selectedWslDistroName)
      ? [selectedWslDistroName, ...wslDistros]
      : wslDistros
  const powerShellImplementation = settings.terminalWindowsPowerShellImplementation ?? 'auto'
  const showWindowsPowerShellImplementation = isWindows && windowsShell === 'powershell.exe'
  const showGitBashOption = gitBashAvailable || windowsShell === WINDOWS_GIT_BASH_SHELL

  const visibleSections = [
    isWindows && matchesSettingsSearch(searchQuery, TERMINAL_WINDOWS_SHELL_SEARCH_ENTRY) ? (
      <section key="windows-shell" className="space-y-3">
        <SettingsSubsectionHeader
          title="Windows Shell"
          description="Default shell for new terminal panes on Windows."
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="Default Shell"
            description="Choose the default shell for new terminal panes on Windows."
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
              label="Default Shell"
              description="Shell used when opening a new terminal pane. Takes effect for new terminals."
              control={
                <SettingsSegmentedControl
                  ariaLabel="Default Shell"
                  value={windowsShell}
                  onChange={(value) => updateSettings({ terminalWindowsShell: value })}
                  options={[
                    { value: 'powershell.exe', label: 'PowerShell' },
                    { value: 'cmd.exe', label: 'Command Prompt' },
                    ...(showGitBashOption
                      ? [
                          {
                            value: WINDOWS_GIT_BASH_SHELL,
                            label: 'Git Bash',
                            disabled: !gitBashAvailable
                          }
                        ]
                      : []),
                    ...(wslAvailable ? [{ value: 'wsl.exe', label: 'WSL' }] : [])
                  ]}
                />
              }
            />
          </SearchableSetting>
          {windowsShell === 'wsl.exe' ? (
            <SearchableSetting
              title="WSL Distribution"
              description="Choose which WSL distribution new WSL terminals and local agent scans use."
              keywords={['terminal', 'windows', 'wsl', 'linux', 'distribution', 'distro', 'ubuntu']}
            >
              <SettingsRow
                label="WSL Distribution"
                description="Used for new WSL terminal panes and local agent detection when the active workspace is not already inside WSL."
                control={
                  <Select
                    value={selectedWslDistro}
                    onValueChange={(value) =>
                      updateSettings({
                        terminalWindowsWslDistro: value === '__default__' ? null : value
                      })
                    }
                    disabled={wslCapabilitiesLoading || !wslAvailable}
                  >
                    <SelectTrigger size="sm" aria-label="WSL Distribution" className="min-w-44">
                      <SelectValue
                        placeholder={
                          wslCapabilitiesLoading ? 'Loading distributions' : 'Windows default'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">Windows default</SelectItem>
                      {wslDistroOptions.map((distro) => (
                        <SelectItem key={distro} value={distro}>
                          {distro}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                }
              />
            </SearchableSetting>
          ) : null}
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_RENDERING_SEARCH_ENTRIES) ? (
      <section key="rendering" className="space-y-3">
        <SettingsSubsectionHeader
          title="Rendering"
          description="Terminal renderer behavior for live panes and new panes."
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="GPU Acceleration"
            description="Controls whether the terminal uses xterm.js WebGL rendering. Auto uses DOM on Linux to avoid driver glyph corruption, and otherwise tries WebGL with DOM fallback."
            keywords={[
              'terminal',
              'gpu',
              'acceleration',
              'webgl',
              'renderer',
              'rendering',
              'graphics',
              'linux',
              'vscode'
            ]}
          >
            <SettingsRow
              label="GPU Acceleration"
              description={
                settings.terminalGpuAcceleration === 'off'
                  ? 'WebGL disabled; DOM renderer for max compatibility.'
                  : settings.terminalGpuAcceleration === 'on'
                    ? 'WebGL is always attempted for terminal panes.'
                    : 'Auto uses DOM on Linux; tries WebGL with DOM fallback elsewhere.'
              }
              control={
                <SettingsSegmentedControl
                  ariaLabel="GPU Acceleration"
                  value={settings.terminalGpuAcceleration ?? 'auto'}
                  onChange={(option) => updateSettings({ terminalGpuAcceleration: option })}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'on', label: 'On' },
                    { value: 'off', label: 'Off' }
                  ]}
                />
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_PANE_INTERACTION_SEARCH_ENTRIES) ||
    (isWindows &&
      matchesSettingsSearch(searchQuery, TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY)) ? (
      <section key="pane-interaction" className="space-y-3">
        <SettingsSubsectionHeader
          title="Terminal Interaction"
          description="Mouse and clipboard behavior for terminal panes."
        />

        <div className="divide-y divide-border/40">
          {/* Why: the Windows-only right-click toggle lives in this section, so the
              section must also match that search term or settings search would hide
              the control even though it is present. */}
          {isWindows &&
            matchesSettingsSearch(searchQuery, TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY) && (
              <SearchableSetting
                title="Right-click to paste"
                description="On Windows, right-click pastes the clipboard into the terminal. Use Ctrl+right-click to open the context menu."
                keywords={['terminal', 'windows', 'right click', 'paste', 'context menu']}
              >
                <SettingsSwitchRow
                  label="Right-click to paste"
                  description="On Windows, right-click pastes the clipboard. Ctrl+right-click opens the context menu."
                  checked={settings.terminalRightClickToPaste}
                  onChange={() =>
                    updateSettings({
                      terminalRightClickToPaste: !settings.terminalRightClickToPaste
                    })
                  }
                />
              </SearchableSetting>
            )}

          <SearchableSetting
            title="Focus Follows Mouse"
            description="Hovering a terminal pane activates it without needing to click."
            keywords={['focus', 'follows', 'mouse', 'hover', 'pane', 'ghostty', 'active']}
          >
            <SettingsSwitchRow
              label="Focus Follows Mouse"
              description="Hovering a terminal pane activates it without needing to click."
              checked={settings.terminalFocusFollowsMouse}
              onChange={() =>
                updateSettings({
                  terminalFocusFollowsMouse: !settings.terminalFocusFollowsMouse
                })
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title="Copy on Select"
            description="Automatically copy terminal selections to the clipboard."
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
              label="Copy on Select"
              description="Automatically copy terminal selections to the clipboard."
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
            title="Allow TUI Clipboard Writes (OSC 52)"
            description="Let tmux, Neovim, and fzf copy to the system clipboard over the PTY (including over SSH)."
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
              label="Allow TUI Clipboard Writes (OSC 52)"
              description="Let programs in the terminal (tmux, Neovim, fzf, SSH) copy to your system clipboard."
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
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_SETUP_SCRIPT_SEARCH_ENTRIES) ? (
      <section key="setup-script" className="space-y-3">
        <SettingsSubsectionHeader
          title="Workspace Setup Script"
          description="Where the repository setup script runs when a new workspace is created."
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="Setup Script Location"
            description="Where the repository setup script runs when a new workspace is created."
            keywords={[
              'setup',
              'script',
              'workspace',
              'split',
              'horizontal',
              'vertical',
              'tab',
              'new',
              'location',
              'launch'
            ]}
          >
            <SettingsRow
              label="Setup Script Location"
              description='"New Tab" opens the setup command in a background tab titled "Setup" without stealing focus.'
              control={
                <ToggleGroup
                  type="single"
                  value={settings.setupScriptLaunchMode}
                  onValueChange={(value) => {
                    if (!value) {
                      return
                    }
                    updateSettings({
                      setupScriptLaunchMode: value as SetupScriptLaunchMode
                    })
                  }}
                  variant="outline"
                  size="sm"
                  className="h-8 flex-wrap"
                >
                  <ToggleGroupItem
                    value="new-tab"
                    className="h-8 px-3 text-xs"
                    aria-label="Run in a new tab"
                  >
                    New Tab
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="split-vertical"
                    className="h-8 px-3 text-xs"
                    aria-label="Split vertically"
                  >
                    Split Vertically
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="split-horizontal"
                    className="h-8 px-3 text-xs"
                    aria-label="Split horizontally"
                  >
                    Split Horizontally
                  </ToggleGroupItem>
                </ToggleGroup>
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, MANAGE_SESSIONS_SEARCH_ENTRIES) ? (
      <ManageSessionsSection key="manage-sessions" />
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_ADVANCED_SEARCH_ENTRIES) ||
    (showWindowsPowerShellImplementation &&
      matchesSettingsSearch(
        searchQuery,
        TERMINAL_WINDOWS_POWERSHELL_IMPLEMENTATION_SEARCH_ENTRY
      )) ||
    (isMac &&
      (matchesSettingsSearch(searchQuery, TERMINAL_MAC_OPTION_SEARCH_ENTRIES) ||
        matchesSettingsSearch(searchQuery, TERMINAL_MAC_YEN_SEARCH_ENTRIES))) ? (
      <section key="advanced" className="space-y-3">
        <SettingsSubsectionHeader
          title="Advanced"
          description="Scrollback, word boundaries, and platform-specific terminal behaviors."
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="Scrollback Size"
            description="Maximum terminal scrollback buffer size."
            keywords={['terminal', 'scrollback', 'buffer', 'memory']}
          >
            <SettingsRow
              alignTop={scrollbackMode === 'custom'}
              label="Scrollback Size"
              description="Maximum terminal scrollback buffer size for new terminal panes."
              control={
                <div className="flex flex-col items-end gap-2">
                  <ToggleGroup
                    type="single"
                    value={scrollbackToggleValue}
                    onValueChange={(value) => {
                      if (!value) {
                        return
                      }
                      if (value === 'custom') {
                        setScrollbackMode('custom')
                        return
                      }

                      setScrollbackMode('preset')
                      updateSettings({
                        terminalScrollbackBytes: Number(value) * 1_000_000
                      })
                    }}
                    variant="outline"
                    size="sm"
                    className="h-8 flex-wrap justify-end"
                  >
                    {SCROLLBACK_PRESETS_MB.map((preset) => (
                      <ToggleGroupItem
                        key={preset}
                        value={`${preset}`}
                        className="h-8 px-3 text-xs"
                        aria-label={`${preset} megabytes`}
                      >
                        {preset} MB
                      </ToggleGroupItem>
                    ))}
                    <ToggleGroupItem
                      value="custom"
                      className="h-8 px-3 text-xs"
                      aria-label="Custom"
                    >
                      Custom
                    </ToggleGroupItem>
                  </ToggleGroup>
                  {scrollbackMode === 'custom' ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        max={256}
                        step={1}
                        value={scrollbackMb}
                        onChange={(e) => {
                          const value = Number(e.target.value)
                          if (Number.isFinite(value)) {
                            updateSettings({
                              terminalScrollbackBytes: clampNumber(value, 1, 256) * 1_000_000
                            })
                          }
                        }}
                        className="number-input-clean w-24 tabular-nums"
                      />
                      <span className="text-xs text-muted-foreground">MB</span>
                    </div>
                  ) : null}
                </div>
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title="Word Separators"
            description="Characters treated as word boundaries for double-click selection."
            keywords={['word', 'separator', 'boundary', 'double-click', 'selection']}
          >
            <SettingsRow
              label="Word Separators"
              description="Characters treated as word boundaries for double-click selection."
              control={
                <Input
                  value={settings.terminalWordSeparator ?? ''}
                  onChange={(e) => {
                    const value = e.target.value
                    updateSettings({ terminalWordSeparator: value || undefined })
                  }}
                  placeholder={` ()[]{},'"\``}
                  className="w-56 font-mono text-xs"
                />
              }
            />
          </SearchableSetting>

          {showWindowsPowerShellImplementation &&
          matchesSettingsSearch(
            searchQuery,
            TERMINAL_WINDOWS_POWERSHELL_IMPLEMENTATION_SEARCH_ENTRY
          ) ? (
            <SearchableSetting
              title="PowerShell Version"
              description="Choose whether the PowerShell shell option launches Windows PowerShell or PowerShell 7+ for new terminal panes."
              keywords={[
                'terminal',
                'windows',
                'powershell',
                'pwsh',
                'powershell 7',
                'windows powershell',
                'version',
                'advanced'
              ]}
            >
              <SettingsRow
                alignTop
                label="PowerShell Version"
                description={
                  pwshAvailable ? (
                    'Choose between Windows PowerShell and PowerShell 7+ for new terminal panes.'
                  ) : (
                    <>
                      Auto uses Windows PowerShell now and switches to PowerShell 7+ when installed.{' '}
                      <a
                        href="https://github.com/PowerShell/PowerShell/releases/latest"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-foreground"
                      >
                        Download PowerShell 7+
                      </a>
                      .
                    </>
                  )
                }
                control={
                  <SettingsSegmentedControl
                    ariaLabel="PowerShell Version"
                    value={powerShellImplementation}
                    onChange={(value) =>
                      updateSettings({ terminalWindowsPowerShellImplementation: value })
                    }
                    options={[
                      { value: 'auto', label: 'Auto' },
                      { value: 'powershell.exe', label: 'Windows PowerShell' },
                      { value: 'pwsh.exe', label: 'PowerShell 7+', disabled: !pwshAvailable }
                    ]}
                  />
                }
              />
            </SearchableSetting>
          ) : null}

          {isMac ? (
            <>
              <SearchableSetting
                title="Option as Alt"
                description="Controls whether the macOS Option key sends Alt/Esc sequences or composes characters."
                keywords={[
                  'terminal',
                  'option',
                  'alt',
                  'key',
                  'meta',
                  'compose',
                  'mac',
                  'macos',
                  'keyboard',
                  'german',
                  'international',
                  'readline',
                  'ghostty'
                ]}
              >
                <SettingsRow
                  alignTop
                  label="Option as Alt"
                  description={
                    settings.terminalMacOptionAsAlt === 'auto'
                      ? `Auto — detected: ${detectedLayoutLabel}.`
                      : settings.terminalMacOptionAsAlt === 'false'
                        ? 'Option composes special characters for your keyboard layout.'
                        : settings.terminalMacOptionAsAlt === 'true'
                          ? 'Both Option keys send Alt/Esc sequences.'
                          : `The ${settings.terminalMacOptionAsAlt} Option key sends Alt/Esc; the other composes special characters.`
                  }
                  control={
                    <SettingsSegmentedControl
                      ariaLabel="Option as Alt"
                      value={settings.terminalMacOptionAsAlt}
                      onChange={(option) => updateSettings({ terminalMacOptionAsAlt: option })}
                      options={[
                        { value: 'auto', label: 'Auto' },
                        { value: 'true', label: 'Both' },
                        { value: 'left', label: 'Left' },
                        { value: 'right', label: 'Right' },
                        { value: 'false', label: 'Off' }
                      ]}
                    />
                  }
                />
              </SearchableSetting>

              <SearchableSetting
                title="JIS Yen (¥) to Backslash (\\)"
                description="Controls whether pressing the JIS Yen (¥) key sends a backslash (\\) instead."
                keywords={[
                  'terminal',
                  'yen',
                  'backslash',
                  'japanese',
                  'keyboard',
                  'mac',
                  'macos',
                  'jis',
                  'intl'
                ]}
              >
                <SettingsSwitchRow
                  label="JIS Yen (¥) to Backslash (\\)"
                  description="Pressing the JIS Yen (¥) key sends a backslash (\\) instead."
                  checked={settings.terminalJISYenToBackslash ?? false}
                  onChange={() =>
                    updateSettings({
                      terminalJISYenToBackslash: !settings.terminalJISYenToBackslash
                    })
                  }
                />
              </SearchableSetting>
            </>
          ) : null}
        </div>
      </section>
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
