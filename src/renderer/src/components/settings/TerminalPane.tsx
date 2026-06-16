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
import { useDetectedOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { ManageSessionsSection } from './ManageSessionsSection'
import { OSC52_CLIPBOARD_SETTING_ID } from '../terminal-pane/osc52-clipboard-setting-anchor'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import { translate } from '@/i18n/i18n'
import { ShellIcon } from '../tab-bar/shell-icons'

const EMPTY_WSL_DISTROS: string[] = []

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
  /** Whether the active terminal host is Windows, even if the client is not. */
  isWindowsTerminalHost?: boolean
}

function windowsShellLabel(shell: string, label: string): React.JSX.Element {
  return (
    <span className="inline-flex items-center justify-center gap-1.5">
      <ShellIcon shell={shell} size={12} />
      <span>{label}</span>
    </span>
  )
}

export function TerminalPane({
  settings,
  updateSettings,
  scrollbackMode,
  setScrollbackMode,
  wslAvailable,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading = false,
  pwshAvailable,
  gitBashAvailable = false,
  isWindowsTerminalHost
}: TerminalPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isWindows = isWindowsUserAgent()
  const showWindowsHostSettings = isWindowsTerminalHost ?? isWindows
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
  const showWindowsPowerShellImplementation =
    showWindowsHostSettings && windowsShell === 'powershell.exe'
  const showGitBashOption = gitBashAvailable || windowsShell === WINDOWS_GIT_BASH_SHELL

  const visibleSections = [
    showWindowsHostSettings &&
    matchesSettingsSearch(searchQuery, getTerminalWindowsShellSearchEntry()) ? (
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
                      : []),
                    ...(wslAvailable
                      ? [
                          {
                            value: 'wsl.exe',
                            label: windowsShellLabel(
                              'wsl.exe',
                              translate('auto.components.settings.TerminalPane.b637dd57a7', 'WSL')
                            ),
                            ariaLabel: translate(
                              'auto.components.settings.TerminalPane.b637dd57a7',
                              'WSL'
                            )
                          }
                        ]
                      : [])
                  ]}
                />
              }
            />
          </SearchableSetting>
          {windowsShell === 'wsl.exe' ? (
            <SearchableSetting
              title={translate(
                'auto.components.settings.TerminalPane.219aaa59f4',
                'WSL Distribution'
              )}
              description={translate(
                'auto.components.settings.TerminalPane.5fe79a5e56',
                'Choose which WSL distribution new WSL terminals and local agent scans use.'
              )}
              keywords={['terminal', 'windows', 'wsl', 'linux', 'distribution', 'distro', 'ubuntu']}
            >
              <SettingsRow
                label={translate(
                  'auto.components.settings.TerminalPane.219aaa59f4',
                  'WSL Distribution'
                )}
                description={translate(
                  'auto.components.settings.TerminalPane.2503f1e86b',
                  'Used for new WSL terminal panes and local agent detection when the active workspace is not already inside WSL.'
                )}
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
                    <SelectTrigger
                      size="sm"
                      aria-label={translate(
                        'auto.components.settings.TerminalPane.219aaa59f4',
                        'WSL Distribution'
                      )}
                      className="min-w-44"
                    >
                      <SelectValue
                        placeholder={
                          wslCapabilitiesLoading
                            ? translate(
                                'auto.components.settings.TerminalPane.d78fc4fdef',
                                'Loading distributions'
                              )
                            : translate(
                                'auto.components.settings.TerminalPane.cc8c5ca224',
                                'Windows default'
                              )
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">
                        {translate(
                          'auto.components.settings.TerminalPane.cc8c5ca224',
                          'Windows default'
                        )}
                      </SelectItem>
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
    matchesSettingsSearch(searchQuery, getTerminalRenderingSearchEntries()) ? (
      <section key="rendering" className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.TerminalPane.2fba319f21', 'Rendering')}
          description={translate(
            'auto.components.settings.TerminalPane.72bc9334a0',
            'Terminal renderer behavior for live panes and new panes.'
          )}
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title={translate(
              'auto.components.settings.TerminalPane.c1fc9e9444',
              'GPU Acceleration'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.f07dfb4466',
              'Controls whether the terminal uses xterm.js WebGL rendering. Auto tries WebGL when the renderer is supported, with a conservative Linux fallback for software or unknown GPU renderers.'
            )}
            keywords={[
              'terminal',
              'gpu',
              'acceleration',
              'webgl',
              'renderer',
              'rendering',
              'graphics',
              'linux'
            ]}
          >
            <SettingsRow
              label={translate(
                'auto.components.settings.TerminalPane.c1fc9e9444',
                'GPU Acceleration'
              )}
              description={
                settings.terminalGpuAcceleration === 'off'
                  ? translate(
                      'auto.components.settings.TerminalPane.fe4acf36c6',
                      'WebGL disabled; DOM renderer for max compatibility.'
                    )
                  : settings.terminalGpuAcceleration === 'on'
                    ? translate(
                        'auto.components.settings.TerminalPane.7eaccc1424',
                        'WebGL is always attempted for terminal panes.'
                      )
                    : translate(
                        'auto.components.settings.TerminalPane.e0996d141a',
                        'Auto tries WebGL, with DOM fallback for unsupported or risky renderers.'
                      )
              }
              control={
                <SettingsSegmentedControl
                  ariaLabel={translate(
                    'auto.components.settings.TerminalPane.c1fc9e9444',
                    'GPU Acceleration'
                  )}
                  value={settings.terminalGpuAcceleration ?? 'auto'}
                  onChange={(option) => updateSettings({ terminalGpuAcceleration: option })}
                  options={[
                    {
                      value: 'auto',
                      label: translate('auto.components.settings.TerminalPane.43c2ff7b0e', 'Auto')
                    },
                    {
                      value: 'on',
                      label: translate('auto.components.settings.TerminalPane.9c0b1c1792', 'On')
                    },
                    {
                      value: 'off',
                      label: translate('auto.components.settings.TerminalPane.3fe1c5bfe0', 'Off')
                    }
                  ]}
                />
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalPaneInteractionSearchEntries()) ||
    (isWindows && matchesSettingsSearch(searchQuery, getTerminalRightClickToPasteSearchEntry())) ? (
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
            matchesSettingsSearch(searchQuery, getTerminalRightClickToPasteSearchEntry()) && (
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
            )}

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
              label={translate(
                'auto.components.settings.TerminalPane.902f5dee1f',
                'Copy on Select'
              )}
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
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalSetupScriptSearchEntries()) ? (
      <section key="setup-script" className="space-y-3">
        <SettingsSubsectionHeader
          title={translate(
            'auto.components.settings.TerminalPane.21f8da2078',
            'Workspace Setup Script'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.34a0dfa06e',
            'Where the repository setup script runs when a new workspace is created.'
          )}
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title={translate(
              'auto.components.settings.TerminalPane.d23b43c5be',
              'Setup Script Location'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.34a0dfa06e',
              'Where the repository setup script runs when a new workspace is created.'
            )}
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
              label={translate(
                'auto.components.settings.TerminalPane.d23b43c5be',
                'Setup Script Location'
              )}
              description={translate(
                'auto.components.settings.TerminalPane.a9d47451d1',
                '"New Tab" opens the setup command in a background tab titled "Setup" without stealing focus.'
              )}
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
                    aria-label={translate(
                      'auto.components.settings.TerminalPane.6c6a054a1c',
                      'Run in a new tab'
                    )}
                  >
                    {translate('auto.components.settings.TerminalPane.1158f8fd55', 'New Tab')}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="split-vertical"
                    className="h-8 px-3 text-xs"
                    aria-label={translate(
                      'auto.components.settings.TerminalPane.691ce810e0',
                      'Split vertically'
                    )}
                  >
                    {translate(
                      'auto.components.settings.TerminalPane.332e8a2872',
                      'Split Vertically'
                    )}
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="split-horizontal"
                    className="h-8 px-3 text-xs"
                    aria-label={translate(
                      'auto.components.settings.TerminalPane.623e62df99',
                      'Split horizontally'
                    )}
                  >
                    {translate(
                      'auto.components.settings.TerminalPane.003df129fe',
                      'Split Horizontally'
                    )}
                  </ToggleGroupItem>
                </ToggleGroup>
              }
            />
          </SearchableSetting>
        </div>
      </section>
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
      <section key="advanced" className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.TerminalPane.5e5f06c82c', 'Advanced')}
          description={translate(
            'auto.components.settings.TerminalPane.267d020745',
            'Scrollback, word boundaries, and platform-specific terminal behaviors.'
          )}
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title={translate('auto.components.settings.TerminalPane.9df53f7c14', 'Scrollback Size')}
            description={translate(
              'auto.components.settings.TerminalPane.c3810b2b42',
              'Maximum terminal scrollback buffer size.'
            )}
            keywords={['terminal', 'scrollback', 'buffer', 'memory']}
          >
            <SettingsRow
              alignTop={scrollbackMode === 'custom'}
              label={translate(
                'auto.components.settings.TerminalPane.9df53f7c14',
                'Scrollback Size'
              )}
              description={translate(
                'auto.components.settings.TerminalPane.81d86b2dd2',
                'Maximum terminal scrollback buffer size for new terminal panes.'
              )}
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
                        aria-label={translate(
                          'auto.components.settings.TerminalPane.5336c096af',
                          '{{value0}} megabytes',
                          { value0: preset }
                        )}
                      >
                        {preset}{' '}
                        {translate('auto.components.settings.TerminalPane.12e06178fa', 'MB')}
                      </ToggleGroupItem>
                    ))}
                    <ToggleGroupItem
                      value="custom"
                      className="h-8 px-3 text-xs"
                      aria-label={translate(
                        'auto.components.settings.TerminalPane.907b0b9d3e',
                        'Custom'
                      )}
                    >
                      {translate('auto.components.settings.TerminalPane.907b0b9d3e', 'Custom')}
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
                      <span className="text-xs text-muted-foreground">
                        {translate('auto.components.settings.TerminalPane.12e06178fa', 'MB')}
                      </span>
                    </div>
                  ) : null}
                </div>
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title={translate('auto.components.settings.TerminalPane.4bebcc2b2c', 'Word Separators')}
            description={translate(
              'auto.components.settings.TerminalPane.8a956cc91e',
              'Characters treated as word boundaries for double-click selection.'
            )}
            keywords={['word', 'separator', 'boundary', 'double-click', 'selection']}
          >
            <SettingsRow
              label={translate(
                'auto.components.settings.TerminalPane.4bebcc2b2c',
                'Word Separators'
              )}
              description={translate(
                'auto.components.settings.TerminalPane.8a956cc91e',
                'Characters treated as word boundaries for double-click selection.'
              )}
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
            getTerminalWindowsPowershellImplementationSearchEntry()
          ) ? (
            <SearchableSetting
              title={translate(
                'auto.components.settings.TerminalPane.fe20f79dd1',
                'PowerShell Version'
              )}
              description={translate(
                'auto.components.settings.TerminalPane.3d88af864d',
                'Choose whether the PowerShell shell option launches Windows PowerShell or PowerShell 7+ for new terminal panes.'
              )}
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
                label={translate(
                  'auto.components.settings.TerminalPane.fe20f79dd1',
                  'PowerShell Version'
                )}
                description={
                  pwshAvailable ? (
                    translate(
                      'auto.components.settings.TerminalPane.5ed5c95344',
                      'Choose between Windows PowerShell and PowerShell 7+ for new terminal panes.'
                    )
                  ) : (
                    <>
                      {translate(
                        'auto.components.settings.TerminalPane.a016ffbeed',
                        'Auto uses Windows PowerShell now and switches to PowerShell 7+ when installed.'
                      )}{' '}
                      <a
                        href="https://github.com/PowerShell/PowerShell/releases/latest"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-foreground"
                      >
                        {translate(
                          'auto.components.settings.TerminalPane.822f62ddcd',
                          'Download PowerShell 7+'
                        )}
                      </a>
                      .
                    </>
                  )
                }
                control={
                  <SettingsSegmentedControl
                    ariaLabel={translate(
                      'auto.components.settings.TerminalPane.fe20f79dd1',
                      'PowerShell Version'
                    )}
                    value={powerShellImplementation}
                    onChange={(value) =>
                      updateSettings({ terminalWindowsPowerShellImplementation: value })
                    }
                    options={[
                      {
                        value: 'auto',
                        label: translate('auto.components.settings.TerminalPane.43c2ff7b0e', 'Auto')
                      },
                      {
                        value: 'powershell.exe',
                        label: translate(
                          'auto.components.settings.TerminalPane.d26174e1dd',
                          'Windows PowerShell'
                        )
                      },
                      {
                        value: 'pwsh.exe',
                        label: translate(
                          'auto.components.settings.TerminalPane.96be03b8eb',
                          'PowerShell 7+'
                        ),
                        disabled: !pwshAvailable
                      }
                    ]}
                  />
                }
              />
            </SearchableSetting>
          ) : null}

          {isMac ? (
            <>
              <SearchableSetting
                title={translate(
                  'auto.components.settings.TerminalPane.0a10420e1a',
                  'Option as Alt'
                )}
                description={translate(
                  'auto.components.settings.TerminalPane.2561d3fc1b',
                  'Controls whether the macOS Option key sends Alt/Esc sequences or composes characters.'
                )}
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
                  label={translate(
                    'auto.components.settings.TerminalPane.0a10420e1a',
                    'Option as Alt'
                  )}
                  description={
                    settings.terminalMacOptionAsAlt === 'auto'
                      ? translate(
                          'auto.components.settings.TerminalPane.d21c493808',
                          'Auto — detected: {{value0}}.',
                          { value0: detectedLayoutLabel }
                        )
                      : settings.terminalMacOptionAsAlt === 'false'
                        ? translate(
                            'auto.components.settings.TerminalPane.d8998bb328',
                            'Option composes special characters for your keyboard layout.'
                          )
                        : settings.terminalMacOptionAsAlt === 'true'
                          ? translate(
                              'auto.components.settings.TerminalPane.b62373091a',
                              'Both Option keys send Alt/Esc sequences.'
                            )
                          : translate(
                              'auto.components.settings.TerminalPane.ce3aadf0b2',
                              'The {{value0}} Option key sends Alt/Esc; the other composes special characters.',
                              { value0: settings.terminalMacOptionAsAlt }
                            )
                  }
                  control={
                    <SettingsSegmentedControl
                      ariaLabel={translate(
                        'auto.components.settings.TerminalPane.0a10420e1a',
                        'Option as Alt'
                      )}
                      value={settings.terminalMacOptionAsAlt}
                      onChange={(option) => updateSettings({ terminalMacOptionAsAlt: option })}
                      options={[
                        {
                          value: 'auto',
                          label: translate(
                            'auto.components.settings.TerminalPane.43c2ff7b0e',
                            'Auto'
                          )
                        },
                        {
                          value: 'true',
                          label: translate(
                            'auto.components.settings.TerminalPane.badb1219fc',
                            'Both'
                          )
                        },
                        {
                          value: 'left',
                          label: translate(
                            'auto.components.settings.TerminalPane.e7aec1fd60',
                            'Left'
                          )
                        },
                        {
                          value: 'right',
                          label: translate(
                            'auto.components.settings.TerminalPane.c73d510938',
                            'Right'
                          )
                        },
                        {
                          value: 'false',
                          label: translate(
                            'auto.components.settings.TerminalPane.3fe1c5bfe0',
                            'Off'
                          )
                        }
                      ]}
                    />
                  }
                />
              </SearchableSetting>

              <SearchableSetting
                title={translate(
                  'auto.components.settings.TerminalPane.19f4935159',
                  'JIS Yen (¥) to Backslash (\\\\)'
                )}
                description={translate(
                  'auto.components.settings.TerminalPane.1c337bef4a',
                  'Controls whether pressing the JIS Yen (¥) key sends a backslash (\\\\) instead.'
                )}
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
                  label={translate(
                    'auto.components.settings.TerminalPane.19f4935159',
                    'JIS Yen (¥) to Backslash (\\\\)'
                  )}
                  description={translate(
                    'auto.components.settings.TerminalPane.4263e940e0',
                    'Pressing the JIS Yen (¥) key sends a backslash (\\\\) instead.'
                  )}
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
