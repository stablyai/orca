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
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { Minus, Plus } from 'lucide-react'
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
  TERMINAL_ADVANCED_SEARCH_ENTRIES,
  TERMINAL_CURSOR_SEARCH_ENTRIES,
  TERMINAL_DARK_THEME_SEARCH_ENTRIES,
  TERMINAL_LIGHT_THEME_SEARCH_ENTRIES,
  TERMINAL_MAC_OPTION_SEARCH_ENTRIES,
  TERMINAL_PANE_STYLE_SEARCH_ENTRIES,
  TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY,
  TERMINAL_SETUP_SCRIPT_SEARCH_ENTRIES,
  TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES,
  TERMINAL_WINDOWS_SHELL_SEARCH_ENTRY
} from './terminal-search'
import { useDetectedOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { detectedCategoryToDefault } from '@/lib/keyboard-layout/detect-option-as-alt'
import { DarkTerminalThemeSection, LightTerminalThemeSection } from './TerminalThemeSections'

type TerminalPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  systemPrefersDark: boolean
  terminalFontSuggestions: string[]
  scrollbackMode: 'preset' | 'custom'
  setScrollbackMode: (mode: 'preset' | 'custom') => void
}

export function TerminalPane({
  settings,
  updateSettings,
  systemPrefersDark,
  terminalFontSuggestions,
  scrollbackMode,
  setScrollbackMode
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
            {(
              [
                { label: 'PowerShell', value: 'powershell.exe' },
                { label: 'Command Prompt', value: 'cmd.exe' }
              ] as const
            ).map(({ label, value }) => (
              <button
                key={value}
                onClick={() => updateSettings({ terminalWindowsShell: value })}
                className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                  (settings.terminalWindowsShell ?? 'powershell.exe') === value
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
    matchesSettingsSearch(searchQuery, TERMINAL_ADVANCED_SEARCH_ENTRIES) ||
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
          title="Force Hyperlink Escapes"
          description="Set FORCE_HYPERLINK=1 in every terminal so tools emit OSC-8 clickable links. Turn off if your shell startup is slow."
          keywords={[
            'terminal',
            'hyperlink',
            'link',
            'osc',
            'osc8',
            'osc-8',
            'force_hyperlink',
            'slow',
            'startup',
            'zsh',
            'zshrc',
            'oh-my-zsh',
            'p10k',
            'powerlevel10k'
          ]}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Force Hyperlink Escapes</Label>
            <p className="text-xs text-muted-foreground">
              Sets{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">FORCE_HYPERLINK=1</code> in
              every spawned terminal so tools like <code>ls</code>, <code>git</code>, and{' '}
              <code>eza</code> emit OSC-8 clickable links. Disable if your shell startup feels slow
              — heavy setups (oh-my-zsh, powerlevel10k, nvm, pyenv, conda) can take measurably
              longer with this on. Only affects newly spawned terminals.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.terminalForceHyperlink}
            onClick={() =>
              updateSettings({
                terminalForceHyperlink: !settings.terminalForceHyperlink
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.terminalForceHyperlink ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.terminalForceHyperlink ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

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
    </div>
  )
}
