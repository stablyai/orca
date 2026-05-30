/* eslint-disable max-lines -- Why: TerminalPane is the single owner of all terminal settings UI;
   splitting individual settings into separate files would scatter related controls without a
   meaningful abstraction boundary. Mirrors the same decision made for GeneralPane.tsx. */
import { useState } from 'react'
import type { GlobalSettings, SetupScriptLaunchMode } from '../../../../shared/types'
import {
  DEFAULT_TERMINAL_FONT_WEIGHT,
  TERMINAL_FONT_WEIGHT_MAX,
  TERMINAL_FONT_WEIGHT_MIN,
  TERMINAL_FONT_WEIGHT_STEP,
  normalizeTerminalFontWeight
} from '../../../../shared/terminal-fonts'
import {
  fontFamilyHasKnownLigatures,
  resolveTerminalLigaturesEnabled
} from '../../../../shared/terminal-ligatures'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Separator } from '../ui/separator'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Minus, Plus } from 'lucide-react'
import { clampNumber, resolvePaneStyleOptions } from '@/lib/terminal-theme'
import {
  FontAutocomplete,
  NumberField,
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
  TERMINAL_CURSOR_SEARCH_ENTRIES,
  TERMINAL_DARK_THEME_SEARCH_ENTRIES,
  TERMINAL_LIGHT_THEME_SEARCH_ENTRIES,
  TERMINAL_MAC_OPTION_SEARCH_ENTRIES,
  TERMINAL_MAC_YEN_SEARCH_ENTRIES,
  TERMINAL_PANE_STYLE_SEARCH_ENTRIES,
  TERMINAL_RENDERING_SEARCH_ENTRIES,
  TERMINAL_SETUP_SCRIPT_SEARCH_ENTRIES,
  TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES,
  TERMINAL_WINDOW_SEARCH_ENTRIES
} from './terminal-search'
import {
  TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY,
  TERMINAL_WINDOWS_POWERSHELL_IMPLEMENTATION_SEARCH_ENTRY,
  TERMINAL_WINDOWS_SHELL_SEARCH_ENTRY
} from './terminal-windows-search'
import { useDetectedOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { DarkTerminalThemeSection, LightTerminalThemeSection } from './TerminalThemeSections'
import { TerminalWindowSection } from './TerminalWindowSection'
import { GhosttyImportModal } from './GhosttyImportModal'
import type { UseGhosttyImportReturn } from './useGhosttyImport'
import { ManageSessionsSection } from './ManageSessionsSection'
import { TerminalSettingsPreview } from './TerminalSettingsPreview'
import { OSC52_CLIPBOARD_SETTING_ID } from '../terminal-pane/osc52-clipboard-setting-anchor'

type TerminalPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  systemPrefersDark: boolean
  terminalFontSuggestions: string[]
  scrollbackMode: 'preset' | 'custom'
  setScrollbackMode: (mode: 'preset' | 'custom') => void
  /** Ghostty import modal state + handlers. Lifted to the Settings shell so
   *  the section header can render the trigger button as a headerAction
   *  instead of taking its own row inside the settings list. */
  ghostty: UseGhosttyImportReturn
  /** Whether WSL is installed on this Windows machine. */
  wslAvailable?: boolean
  /** Installed WSL distro names, used to choose the default WSL terminal target. */
  wslDistros?: string[]
  /** Whether WSL capability probing is still in flight. */
  wslCapabilitiesLoading?: boolean
  /** Whether PowerShell 7+ (pwsh.exe) is installed on this Windows machine. */
  pwshAvailable?: boolean
}

export function TerminalPane({
  settings,
  updateSettings,
  systemPrefersDark,
  terminalFontSuggestions,
  scrollbackMode,
  setScrollbackMode,
  ghostty,
  wslAvailable,
  wslDistros = [],
  wslCapabilitiesLoading = false,
  pwshAvailable
}: TerminalPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isWindows = isWindowsUserAgent()
  const isMac = isMacUserAgent()
  const [themeSearchDark, setThemeSearchDark] = useState('')
  const [themeSearchLight, setThemeSearchLight] = useState('')
  // Why: hover preview lets the font picker update the sample without committing a setting.
  const [previewFontFamily, setPreviewFontFamily] = useState<string | null>(null)

  const paneStyleOptions = resolvePaneStyleOptions(settings)
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
    matchesSettingsSearch(searchQuery, TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES) ? (
      <section key="typography" className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-3">
          <SettingsSubsectionHeader
            title="Typography"
            description="Default terminal typography for new panes and live updates."
          />

          <div className="divide-y divide-border/40">
            <SearchableSetting
              title="Font Size"
              description="Default terminal font size for new panes and live updates."
              keywords={['terminal', 'typography', 'text size']}
            >
              <SettingsRow
                label="Font Size"
                description="Default terminal font size for new panes and live updates."
                control={
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() => {
                        const next = Math.max(10, settings.terminalFontSize - 1)
                        updateSettings({ terminalFontSize: next })
                      }}
                      disabled={settings.terminalFontSize <= 10}
                    >
                      <Minus className="size-3" />
                    </Button>
                    <Input
                      type="number"
                      min={10}
                      max={24}
                      value={settings.terminalFontSize}
                      onChange={(e) => {
                        const value = parseInt(e.target.value, 10)
                        if (!Number.isNaN(value) && value >= 10 && value <= 24) {
                          updateSettings({ terminalFontSize: value })
                        }
                      }}
                      className="w-14 text-center tabular-nums"
                    />
                    <Button
                      variant="outline"
                      size="icon-sm"
                      onClick={() => {
                        const next = Math.min(24, settings.terminalFontSize + 1)
                        updateSettings({ terminalFontSize: next })
                      }}
                      disabled={settings.terminalFontSize >= 24}
                    >
                      <Plus className="size-3" />
                    </Button>
                    <span className="text-xs text-muted-foreground">px</span>
                  </div>
                }
              />
            </SearchableSetting>

            <SearchableSetting
              title="Font Family"
              description="Default terminal font family for new panes and live updates."
              keywords={['terminal', 'typography', 'font']}
            >
              <SettingsRow
                alignTop
                label="Font Family"
                description="Default terminal font family for new panes and live updates."
                control={
                  <FontAutocomplete
                    value={settings.terminalFontFamily}
                    suggestions={terminalFontSuggestions}
                    onChange={(value) => updateSettings({ terminalFontFamily: value })}
                    onPreviewFontFamily={setPreviewFontFamily}
                  />
                }
              />
            </SearchableSetting>

            <SearchableSetting
              title="Font Weight"
              description="Controls the terminal text font weight."
              keywords={['terminal', 'typography', 'weight']}
            >
              <NumberField
                label="Font Weight"
                description="Controls the terminal text font weight."
                value={normalizeTerminalFontWeight(settings.terminalFontWeight)}
                defaultValue={DEFAULT_TERMINAL_FONT_WEIGHT}
                min={TERMINAL_FONT_WEIGHT_MIN}
                max={TERMINAL_FONT_WEIGHT_MAX}
                step={TERMINAL_FONT_WEIGHT_STEP}
                suffix="100–900"
                onChange={(value) =>
                  updateSettings({
                    terminalFontWeight: normalizeTerminalFontWeight(value)
                  })
                }
              />
            </SearchableSetting>

            <SearchableSetting
              title="Line Height"
              description="Controls the terminal line height multiplier."
              keywords={['terminal', 'typography', 'line height', 'spacing']}
            >
              <NumberField
                label="Line Height"
                description="Controls the terminal line height multiplier."
                value={settings.terminalLineHeight}
                defaultValue={1}
                min={1}
                max={3}
                step={0.1}
                suffix="1–3"
                onChange={(value) =>
                  updateSettings({
                    terminalLineHeight: clampNumber(value, 1, 3)
                  })
                }
              />
            </SearchableSetting>

            <SearchableSetting
              title="Font Ligatures"
              description='Render programming ligatures (e.g. =>, !=, ===) for fonts that ship them. "Auto" enables ligatures only for known ligature fonts (Fira Code, JetBrains Mono, Cascadia Code, Iosevka, etc.).'
              keywords={[
                'terminal',
                'typography',
                'ligatures',
                'ligature',
                'fira code',
                'jetbrains mono',
                'cascadia code',
                'iosevka',
                'calt',
                'font features'
              ]}
            >
              <SettingsRow
                label="Font Ligatures"
                description={
                  settings.terminalLigatures === 'on'
                    ? 'Always on. Fonts without ligatures simply render as-is.'
                    : settings.terminalLigatures === 'off'
                      ? 'Always off, even for fonts that ship them.'
                      : fontFamilyHasKnownLigatures(settings.terminalFontFamily)
                        ? `Auto — enabled for "${settings.terminalFontFamily}".`
                        : `Auto — disabled for "${
                            settings.terminalFontFamily || 'the current font'
                          }".`
                }
                control={
                  <SettingsSegmentedControl
                    ariaLabel="Font Ligatures"
                    value={settings.terminalLigatures ?? 'auto'}
                    onChange={(option) => updateSettings({ terminalLigatures: option })}
                    options={[
                      { value: 'auto', label: 'Auto' },
                      { value: 'on', label: 'On' },
                      { value: 'off', label: 'Off' }
                    ]}
                  />
                }
              />
              {/* Why: surface the resolved state explicitly so the "Auto" label
                  isn't ambiguous when a user is staring at it. */}
              <p className="sr-only" aria-live="polite">
                Ligatures are currently{' '}
                {resolveTerminalLigaturesEnabled(
                  settings.terminalLigatures,
                  settings.terminalFontFamily
                )
                  ? 'enabled'
                  : 'disabled'}
                .
              </p>
            </SearchableSetting>
          </div>
        </div>
        <TerminalSettingsPreview
          title="Preview"
          settings={settings}
          systemPrefersDark={systemPrefersDark}
          previewFontFamily={previewFontFamily}
          showThemeToggle
        />
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
    matchesSettingsSearch(searchQuery, TERMINAL_CURSOR_SEARCH_ENTRIES) ? (
      <section key="cursor" className="space-y-3">
        <SettingsSubsectionHeader
          title="Cursor"
          description="Default cursor appearance for Orca terminal panes."
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="Cursor Shape"
            description="Default cursor appearance for Orca terminal panes."
            keywords={['terminal', 'cursor', 'bar', 'block', 'underline']}
          >
            <SettingsRow
              label="Cursor Shape"
              description="Default cursor appearance for Orca terminal panes."
              control={
                <SettingsSegmentedControl
                  ariaLabel="Cursor Shape"
                  value={settings.terminalCursorStyle}
                  onChange={(option) => updateSettings({ terminalCursorStyle: option })}
                  options={[
                    { value: 'bar', label: 'Bar' },
                    { value: 'block', label: 'Block' },
                    { value: 'underline', label: 'Underline' }
                  ]}
                />
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title="Blinking Cursor"
            description="Uses the blinking variant of the selected cursor shape."
            keywords={['terminal', 'cursor', 'blink']}
          >
            <SettingsSwitchRow
              label="Blinking Cursor"
              description="Uses the blinking variant of the selected cursor shape."
              checked={settings.terminalCursorBlink}
              onChange={() =>
                updateSettings({ terminalCursorBlink: !settings.terminalCursorBlink })
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title="Cursor Opacity"
            description="Opacity of the terminal cursor."
            keywords={['terminal', 'cursor', 'opacity', 'transparency']}
          >
            <NumberField
              label="Cursor Opacity"
              description="Opacity of the terminal cursor."
              value={settings.terminalCursorOpacity ?? 1}
              defaultValue={1}
              min={0}
              max={1}
              step={0.05}
              suffix="0–1"
              onChange={(value) =>
                updateSettings({
                  terminalCursorOpacity: clampNumber(value, 0, 1)
                })
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_PANE_STYLE_SEARCH_ENTRIES) ||
    (isWindows &&
      matchesSettingsSearch(searchQuery, TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY)) ? (
      <section key="pane-styling" className="space-y-3">
        <SettingsSubsectionHeader
          title="Pane Styling"
          description="Control inactive pane dimming, divider thickness, mouse behavior, and transition timing."
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="Inactive Pane Opacity"
            description="Opacity applied to panes that are not currently active."
            keywords={['pane', 'opacity', 'dimming']}
          >
            <NumberField
              label="Inactive Pane Opacity"
              description="Opacity applied to panes that are not currently active."
              value={paneStyleOptions.inactivePaneOpacity}
              defaultValue={0.8}
              min={0}
              max={1}
              step={0.05}
              suffix="0–1"
              onChange={(value) =>
                updateSettings({
                  terminalInactivePaneOpacity: clampNumber(value, 0, 1)
                })
              }
            />
          </SearchableSetting>
          <SearchableSetting
            title="Divider Thickness"
            description="Thickness of the pane divider line."
            keywords={['pane', 'divider', 'thickness']}
          >
            <NumberField
              label="Divider Thickness"
              description="Thickness of the pane divider line."
              value={paneStyleOptions.dividerThicknessPx}
              defaultValue={1}
              min={1}
              max={32}
              step={1}
              suffix="px"
              onChange={(value) =>
                updateSettings({
                  terminalDividerThicknessPx: clampNumber(value, 1, 32)
                })
              }
            />
          </SearchableSetting>

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
    matchesSettingsSearch(searchQuery, TERMINAL_WINDOW_SEARCH_ENTRIES) ? (
      <TerminalWindowSection key="window" settings={settings} updateSettings={updateSettings} />
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_DARK_THEME_SEARCH_ENTRIES) ? (
      <DarkTerminalThemeSection
        key="dark-theme"
        settings={settings}
        systemPrefersDark={systemPrefersDark}
        themeSearchDark={themeSearchDark}
        setThemeSearchDark={setThemeSearchDark}
        updateSettings={updateSettings}
        previewFontFamily={previewFontFamily}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_LIGHT_THEME_SEARCH_ENTRIES) ? (
      <LightTerminalThemeSection
        key="light-theme"
        settings={settings}
        themeSearchLight={themeSearchLight}
        setThemeSearchLight={setThemeSearchLight}
        updateSettings={updateSettings}
        previewFontFamily={previewFontFamily}
      />
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
      <GhosttyImportModal
        open={ghostty.open}
        onOpenChange={ghostty.handleOpenChange}
        preview={ghostty.preview}
        loading={ghostty.loading}
        onApply={ghostty.handleApply}
        applied={ghostty.applied}
        applyError={ghostty.applyError}
      />
    </div>
  )
}
