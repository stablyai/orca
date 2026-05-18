/* eslint-disable max-lines -- Why: TerminalPane is the single owner of all terminal settings UI;
   splitting individual settings into separate files would scatter related controls without a
   meaningful abstraction boundary. Mirrors the same decision made for GeneralPane.tsx. */
import { useState } from 'react'
import type {
  FloatingTerminalTriggerLocation,
  GlobalSettings,
  SetupScriptLaunchMode
} from '../../../../shared/types'
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
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { FolderOpen, Minus, Plus } from 'lucide-react'
import {
  clampNumber,
  resolveEffectiveTerminalAppearance,
  resolvePaneStyleOptions
} from '@/lib/terminal-theme'
import { NumberField, FontAutocomplete } from './SettingsFormControls'
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
  TERMINAL_FLOATING_SEARCH_ENTRIES,
  TERMINAL_PANE_STYLE_SEARCH_ENTRIES,
  TERMINAL_QUICK_COMMANDS_SEARCH_ENTRIES,
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
import { detectedCategoryToDefault } from '@/lib/keyboard-layout/detect-option-as-alt'
import { DarkTerminalThemeSection, LightTerminalThemeSection } from './TerminalThemeSections'
import { TerminalWindowSection } from './TerminalWindowSection'
import { GhosttyImportModal } from './GhosttyImportModal'
import type { UseGhosttyImportReturn } from './useGhosttyImport'
import { ManageSessionsSection } from './ManageSessionsSection'
import { TerminalQuickCommandsSection } from './TerminalQuickCommandsSection'

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
  pwshAvailable
}: TerminalPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isWindows = isWindowsUserAgent()
  const isMac = isMacUserAgent()
  const [themeSearchDark, setThemeSearchDark] = useState('')
  const [themeSearchLight, setThemeSearchLight] = useState('')

  const darkPreviewAppearance = resolveEffectiveTerminalAppearance(
    { ...settings, theme: 'dark' },
    systemPrefersDark
  )
  const lightPreviewAppearance = resolveEffectiveTerminalAppearance(
    { ...settings, theme: 'light' },
    systemPrefersDark
  )
  const paneStyleOptions = resolvePaneStyleOptions(settings)
  const detectedLayout = useDetectedOptionAsAlt()
  const autoDetectedDefault = detectedCategoryToDefault(detectedLayout)
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
  const powerShellImplementation = settings.terminalWindowsPowerShellImplementation ?? 'auto'
  const showWindowsPowerShellImplementation = isWindows && windowsShell === 'powershell.exe'
  const pickFloatingTerminalDirectory = async (): Promise<void> => {
    const path = await window.api.repos.pickFolder()
    if (!path) {
      return
    }
    updateSettings({ floatingTerminalCwd: path })
  }

  const visibleSections = [
    isWindows && matchesSettingsSearch(searchQuery, TERMINAL_WINDOWS_SHELL_SEARCH_ENTRY) ? (
      <section key="windows-shell" className="space-y-4">
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
          className="space-y-2"
        >
          <Label>Default Shell</Label>
          <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
            {[
              { label: 'PowerShell', value: 'powershell.exe' },
              { label: 'Command Prompt', value: 'cmd.exe' },
              ...(wslAvailable ? [{ label: 'WSL', value: 'wsl.exe' }] : [])
            ].map(({ label, value }) => (
              <button
                key={value}
                onClick={() => updateSettings({ terminalWindowsShell: value })}
                className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                  windowsShell === value
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Shell used when opening a new terminal pane. Takes effect for new terminals.
          </p>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_FLOATING_SEARCH_ENTRIES) ? (
      <section key="floating-terminal" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Floating Terminal</h3>
          <p className="text-xs text-muted-foreground">
            Global floating terminal tabs outside any repo or worktree.
          </p>
        </div>

        <SearchableSetting
          title="Floating Terminal"
          description="Enable the global floating terminal and choose where new tabs start."
          keywords={['terminal', 'global', 'floating', 'quick terminal', 'launch directory']}
          className="space-y-3"
        >
          <div className="flex items-center justify-between gap-4 px-1 py-2">
            <div className="space-y-0.5">
              <Label>Enable Floating Terminal</Label>
              <p className="text-xs text-muted-foreground">
                Shows the global terminal button and floating terminal panel.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.floatingTerminalEnabled}
              onClick={() =>
                updateSettings({
                  floatingTerminalEnabled: !settings.floatingTerminalEnabled
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.floatingTerminalEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                  settings.floatingTerminalEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          <div className="space-y-2">
            <Label>Default Directory</Label>
            <div className="flex max-w-xl gap-2">
              <Input
                value={settings.floatingTerminalCwd || '~'}
                onChange={(event) =>
                  updateSettings({
                    floatingTerminalCwd: event.target.value
                  })
                }
                placeholder="~"
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Choose floating terminal directory"
                onClick={() => void pickFloatingTerminalDirectory()}
              >
                <FolderOpen className="size-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Takes effect for new Floating Terminal tabs. Use ~ for your home directory.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Toggle Button Location</Label>
            <ToggleGroup
              type="single"
              value={settings.floatingTerminalTriggerLocation ?? 'floating-button'}
              onValueChange={(value) => {
                if (!value) {
                  return
                }
                updateSettings({
                  floatingTerminalTriggerLocation: value as FloatingTerminalTriggerLocation
                })
              }}
              className="justify-start"
            >
              <ToggleGroupItem value="floating-button">Floating Button</ToggleGroupItem>
              <ToggleGroupItem value="status-bar">Status Bar</ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              The keyboard shortcut works regardless of where the toggle is shown.
            </p>
          </div>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_QUICK_COMMANDS_SEARCH_ENTRIES) ? (
      <section key="quick-commands" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Quick Commands</h3>
          <p className="text-xs text-muted-foreground">
            Save terminal input snippets for the terminal right-click menu.
          </p>
        </div>

        <SearchableSetting
          title="Quick Commands"
          description="Create, edit, and remove terminal command snippets for the right-click menu."
          keywords={['terminal', 'command', 'snippet', 'quick command', 'send', 'context menu']}
          className="space-y-3"
        >
          <TerminalQuickCommandsSection
            commands={settings.terminalQuickCommands ?? []}
            onChange={(terminalQuickCommands) => updateSettings({ terminalQuickCommands })}
          />
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES) ? (
      <section key="typography" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Typography</h3>
          <p className="text-xs text-muted-foreground">
            Default terminal typography for new panes and live updates.
          </p>
        </div>

        <SearchableSetting
          title="Font Size"
          description="Default terminal font size for new panes and live updates."
          keywords={['terminal', 'typography', 'text size']}
          className="space-y-2"
        >
          <Label>Font Size</Label>
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
              className="w-16 text-center tabular-nums"
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
        </SearchableSetting>

        <SearchableSetting
          title="Font Family"
          description="Default terminal font family for new panes and live updates."
          keywords={['terminal', 'typography', 'font']}
          className="space-y-2"
        >
          <Label>Font Family</Label>
          <FontAutocomplete
            value={settings.terminalFontFamily}
            suggestions={terminalFontSuggestions}
            onChange={(value) => updateSettings({ terminalFontFamily: value })}
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
            suffix="100 to 900"
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
            suffix="1 to 3"
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
          className="space-y-2"
        >
          <Label>Font Ligatures</Label>
          <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
            {(['auto', 'on', 'off'] as const).map((option) => (
              <button
                key={option}
                onClick={() => updateSettings({ terminalLigatures: option })}
                className={`rounded-sm px-3 py-1 text-sm capitalize transition-colors ${
                  (settings.terminalLigatures ?? 'auto') === option
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {option === 'auto' ? 'Auto' : option === 'on' ? 'On' : 'Off'}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {settings.terminalLigatures === 'on'
              ? 'Ligatures are always on. Fonts without ligatures simply render as-is.'
              : settings.terminalLigatures === 'off'
                ? 'Ligatures are always off, even for fonts that ship them.'
                : fontFamilyHasKnownLigatures(settings.terminalFontFamily)
                  ? `Auto — enabled because "${settings.terminalFontFamily}" is a known ligature font. Switch to "Off" to disable.`
                  : `Auto — disabled because "${
                      settings.terminalFontFamily || 'the current font'
                    }" is not a known ligature font. Switch to "On" to enable anyway.`}
          </p>
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
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_RENDERING_SEARCH_ENTRIES) ? (
      <section key="rendering" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Rendering</h3>
          <p className="text-xs text-muted-foreground">
            Terminal renderer behavior for live panes and new panes.
          </p>
        </div>

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
          className="space-y-2"
        >
          <Label>GPU Acceleration</Label>
          <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
            {(['auto', 'on', 'off'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => updateSettings({ terminalGpuAcceleration: option })}
                className={`rounded-sm px-3 py-1 text-sm capitalize transition-colors ${
                  (settings.terminalGpuAcceleration ?? 'auto') === option
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {option === 'auto' ? 'Auto' : option === 'on' ? 'On' : 'Off'}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {settings.terminalGpuAcceleration === 'off'
              ? 'WebGL is disabled; xterm uses the DOM renderer for maximum compatibility.'
              : settings.terminalGpuAcceleration === 'on'
                ? 'WebGL is always attempted for terminal panes.'
                : 'Auto uses the DOM renderer on Linux to avoid GPU glyph corruption, and otherwise tries WebGL with DOM fallback.'}
          </p>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_CURSOR_SEARCH_ENTRIES) ? (
      <section key="cursor" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Cursor</h3>
          <p className="text-xs text-muted-foreground">
            Default cursor appearance for Orca terminal panes.
          </p>
        </div>

        <div className="space-y-4">
          <SearchableSetting
            title="Cursor Shape"
            description="Default cursor appearance for Orca terminal panes."
            keywords={['terminal', 'cursor', 'bar', 'block', 'underline']}
            className="space-y-2"
          >
            <Label>Cursor Shape</Label>
            <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
              {(['bar', 'block', 'underline'] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => updateSettings({ terminalCursorStyle: option })}
                  className={`rounded-sm px-3 py-1 text-sm capitalize transition-colors ${
                    settings.terminalCursorStyle === option
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          </SearchableSetting>

          <SearchableSetting
            title="Blinking Cursor"
            description="Uses the blinking variant of the selected cursor shape."
            keywords={['terminal', 'cursor', 'blink']}
            className="flex items-center justify-between gap-4 px-1 py-2"
          >
            <div className="space-y-0.5">
              <Label>Blinking Cursor</Label>
              <p className="text-xs text-muted-foreground">
                Uses the blinking variant of the selected cursor shape.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={settings.terminalCursorBlink}
              onClick={() =>
                updateSettings({
                  terminalCursorBlink: !settings.terminalCursorBlink
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.terminalCursorBlink ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                  settings.terminalCursorBlink ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
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
              suffix="0 to 1"
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
      <section key="pane-styling" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Pane Styling</h3>
          <p className="text-xs text-muted-foreground">
            Control inactive pane dimming, divider thickness, mouse behavior, and transition timing.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
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
              suffix="0 to 1"
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
        </div>

        {/* Why: the Windows-only right-click toggle lives in this section, so the
            section must also match that search term or settings search would hide
            the control even though it is present. */}
        {isWindows &&
          matchesSettingsSearch(searchQuery, TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY) && (
            <SearchableSetting
              title="Right-click to paste"
              description="On Windows, right-click pastes the clipboard into the terminal. Use Ctrl+right-click to open the context menu."
              keywords={['terminal', 'windows', 'right click', 'paste', 'context menu']}
              className="flex items-center justify-between gap-4 px-1 py-2"
            >
              <div className="space-y-0.5">
                <Label>Right-click to paste</Label>
                <p className="text-xs text-muted-foreground">
                  On Windows, right-click pastes the clipboard into the terminal. Use
                  Ctrl+right-click to open the context menu.
                </p>
              </div>
              <button
                role="switch"
                aria-checked={settings.terminalRightClickToPaste}
                onClick={() =>
                  updateSettings({
                    terminalRightClickToPaste: !settings.terminalRightClickToPaste
                  })
                }
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                  settings.terminalRightClickToPaste ? 'bg-foreground' : 'bg-muted-foreground/30'
                }`}
              >
                <span
                  className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                    settings.terminalRightClickToPaste ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </SearchableSetting>
          )}

        <SearchableSetting
          title="Focus Follows Mouse"
          description="Hovering a terminal pane activates it without needing to click. Mirrors Ghostty's focus-follows-mouse setting. Selections and window switching stay safe."
          keywords={['focus', 'follows', 'mouse', 'hover', 'pane', 'ghostty', 'active']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Focus Follows Mouse</Label>
            <p className="text-xs text-muted-foreground">
              Hovering a terminal pane activates it without needing to click. Mirrors Ghostty&apos;s
              focus-follows-mouse setting. Selections and window switching stay safe.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.terminalFocusFollowsMouse}
            onClick={() =>
              updateSettings({
                terminalFocusFollowsMouse: !settings.terminalFocusFollowsMouse
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.terminalFocusFollowsMouse ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.terminalFocusFollowsMouse ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

        <SearchableSetting
          title="Copy on Select"
          description="Automatically copy terminal selections to the clipboard as soon as a selection is made."
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
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Copy on Select</Label>
            <p className="text-xs text-muted-foreground">
              Automatically copy terminal selections to the clipboard as soon as a selection is
              made.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.terminalClipboardOnSelect}
            onClick={() =>
              updateSettings({
                terminalClipboardOnSelect: !settings.terminalClipboardOnSelect
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.terminalClipboardOnSelect ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.terminalClipboardOnSelect ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

        <SearchableSetting
          title="Allow TUI Clipboard Writes (OSC 52)"
          description="Let terminal programs like tmux, Neovim, and fzf copy to the system clipboard over the PTY (including over SSH). Off by default because untrusted output piped into the terminal could silently overwrite your clipboard."
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
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Allow TUI Clipboard Writes (OSC 52)</Label>
            <p className="text-xs text-muted-foreground">
              Let programs running inside the terminal (tmux, Neovim, fzf, ssh sessions) copy to
              your system clipboard. Disabled by default for safety.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.terminalAllowOsc52Clipboard}
            onClick={() =>
              updateSettings({
                terminalAllowOsc52Clipboard: !settings.terminalAllowOsc52Clipboard
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.terminalAllowOsc52Clipboard ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.terminalAllowOsc52Clipboard ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>
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
        previewProps={paneStyleOptions}
        darkPreviewAppearance={darkPreviewAppearance}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_LIGHT_THEME_SEARCH_ENTRIES) ? (
      <LightTerminalThemeSection
        key="light-theme"
        settings={settings}
        themeSearchLight={themeSearchLight}
        setThemeSearchLight={setThemeSearchLight}
        updateSettings={updateSettings}
        previewProps={paneStyleOptions}
        lightPreviewAppearance={lightPreviewAppearance}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_SETUP_SCRIPT_SEARCH_ENTRIES) ? (
      <section key="setup-script" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Workspace Setup Script</h3>
          <p className="text-xs text-muted-foreground">
            Where the repository setup script runs when a new workspace is created.
          </p>
        </div>

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
          className="space-y-2"
        >
          <Label>Setup Script Location</Label>
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
          <p className="text-xs text-muted-foreground">
            &quot;New Tab&quot; opens the setup command in a background tab titled &quot;Setup&quot;
            without stealing focus from your main terminal.
          </p>
        </SearchableSetting>
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
    (isMac && matchesSettingsSearch(searchQuery, TERMINAL_MAC_OPTION_SEARCH_ENTRIES)) ? (
      <section key="advanced" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Advanced</h3>
          <p className="text-xs text-muted-foreground">
            Scrollback is bounded for stability. This setting applies to new terminal panes.
          </p>
        </div>

        <SearchableSetting
          title="Scrollback Size"
          description="Maximum terminal scrollback buffer size."
          keywords={['terminal', 'scrollback', 'buffer', 'memory']}
          className="space-y-3"
        >
          <Label>Scrollback Size</Label>
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
            className="h-8 flex-wrap"
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
            <ToggleGroupItem value="custom" className="h-8 px-3 text-xs" aria-label="Custom">
              Custom
            </ToggleGroupItem>
          </ToggleGroup>

          {scrollbackMode === 'custom' ? (
            <NumberField
              label="Custom Scrollback"
              description="Maximum terminal scrollback buffer size."
              value={scrollbackMb}
              defaultValue={10}
              min={1}
              max={256}
              step={1}
              suffix="MB"
              onChange={(value) =>
                updateSettings({
                  terminalScrollbackBytes: clampNumber(value, 1, 256) * 1_000_000
                })
              }
            />
          ) : null}
        </SearchableSetting>

        <SearchableSetting
          title="Word Separators"
          description="Characters treated as word boundaries for double-click selection."
          keywords={['word', 'separator', 'boundary', 'double-click', 'selection']}
          className="space-y-2"
        >
          <Label>Word Separators</Label>
          <Input
            value={settings.terminalWordSeparator ?? ''}
            onChange={(e) => {
              const value = e.target.value
              updateSettings({ terminalWordSeparator: value || undefined })
            }}
            placeholder={` ()[]{},'"\``}
            className="max-w-sm"
          />
          <p className="text-xs text-muted-foreground">
            Characters treated as word boundaries for double-click selection.
          </p>
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
            className="space-y-2"
          >
            <Label>PowerShell Version</Label>
            <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
              {[
                { label: 'Auto', value: 'auto' },
                { label: 'Windows PowerShell', value: 'powershell.exe' },
                { label: 'PowerShell 7+', value: 'pwsh.exe', disabled: !pwshAvailable }
              ].map(({ label, value, disabled }) => (
                <button
                  key={value}
                  onClick={() => {
                    if (disabled) {
                      return
                    }
                    updateSettings({
                      terminalWindowsPowerShellImplementation: value as
                        | 'auto'
                        | 'powershell.exe'
                        | 'pwsh.exe'
                    })
                  }}
                  aria-disabled={disabled ? 'true' : undefined}
                  className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                    powerShellImplementation === value
                      ? 'bg-accent font-medium text-accent-foreground'
                      : disabled
                        ? 'cursor-not-allowed text-muted-foreground/50'
                        : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {!pwshAvailable ? (
              <p className="text-xs text-muted-foreground">
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
              </p>
            ) : null}
          </SearchableSetting>
        ) : null}
        {isMac ? (
          <SearchableSetting
            title="Option as Alt"
            description="Controls whether the macOS Option key sends Alt/Esc sequences or composes characters. Mirrors Ghostty's macos-option-as-alt."
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
            className="space-y-2"
          >
            <Label>Option as Alt</Label>
            <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
              {(['auto', 'true', 'left', 'right', 'false'] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => updateSettings({ terminalMacOptionAsAlt: option })}
                  className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                    settings.terminalMacOptionAsAlt === option
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {option === 'auto'
                    ? 'Auto'
                    : option === 'false'
                      ? 'Off'
                      : option === 'true'
                        ? 'Both'
                        : option === 'left'
                          ? 'Left'
                          : 'Right'}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {settings.terminalMacOptionAsAlt === 'auto'
                ? `Auto — detected: ${detectedLayoutLabel}. ${
                    autoDetectedDefault === 'true'
                      ? 'Both Option keys act as Alt, matching macOS power-user readline expectations. Switch to "Off" if you need to type Option-layer characters.'
                      : 'Option composes your keyboard layout’s special characters (@, €, [, ], etc.). Core readline shortcuts (Option+B/F/D) are handled automatically.'
                  }`
                : settings.terminalMacOptionAsAlt === 'false'
                  ? 'Option composes special characters for your keyboard layout. Core readline shortcuts (Option+B/F/D) are handled automatically.'
                  : settings.terminalMacOptionAsAlt === 'true'
                    ? 'Both Option keys send Alt/Esc sequences for full readline and shell support. Special character input via Option is unavailable.'
                    : `The ${settings.terminalMacOptionAsAlt} Option key sends Alt/Esc sequences; the other composes special characters.`}
            </p>
          </SearchableSetting>
        ) : null}
      </section>
    ) : null
  ].filter(Boolean)

  return (
    <div className="space-y-8">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
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
