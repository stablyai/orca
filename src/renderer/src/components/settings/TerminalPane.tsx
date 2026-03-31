import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
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
import { TerminalThemePreview } from './TerminalThemePreview'
import { Minus, Plus } from 'lucide-react'
import {
  clampNumber,
  resolveEffectiveTerminalAppearance,
  resolvePaneStyleOptions
} from '@/lib/terminal-theme'
import { ThemePicker, ColorField, NumberField, FontAutocomplete } from './SettingsFormControls'
import { SCROLLBACK_PRESETS_MB } from './SettingsConstants'

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
  const scrollbackMb = Math.max(1, Math.round(settings.terminalScrollbackBytes / 1_000_000))
  const isPreset = SCROLLBACK_PRESETS_MB.includes(
    scrollbackMb as (typeof SCROLLBACK_PRESETS_MB)[number]
  )
  const scrollbackToggleValue =
    scrollbackMode === 'custom' ? 'custom' : isPreset ? `${scrollbackMb}` : 'custom'

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Typography</h2>
          <p className="text-xs text-muted-foreground">
            Default terminal typography for new panes and live updates.
          </p>
        </div>

        <div className="space-y-2">
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
        </div>

        <div className="space-y-2">
          <Label>Font Family</Label>
          <FontAutocomplete
            value={settings.terminalFontFamily}
            suggestions={terminalFontSuggestions}
            onChange={(value) => updateSettings({ terminalFontFamily: value })}
          />
        </div>

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
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Cursor</h2>
          <p className="text-xs text-muted-foreground">
            Default cursor appearance for Orca terminal panes.
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
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
          </div>

          <div className="flex items-center justify-between gap-4 px-1 py-2">
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
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Pane Styling</h2>
          <p className="text-xs text-muted-foreground">
            Control inactive pane dimming, divider thickness, and transition timing.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
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
        </div>
      </section>

      <Separator />

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <ThemePicker
            label="Dark Theme"
            description="Choose the terminal theme used in dark mode."
            selectedTheme={settings.terminalThemeDark}
            query={themeSearchDark}
            onQueryChange={setThemeSearchDark}
            onSelectTheme={(theme) => updateSettings({ terminalThemeDark: theme })}
          />

          <ColorField
            label="Dark Divider Color"
            description="Controls the split divider line between panes in dark mode."
            value={settings.terminalDividerColorDark}
            fallback="#3f3f46"
            onChange={(value) => updateSettings({ terminalDividerColorDark: value })}
          />
        </div>

        <TerminalThemePreview
          title="Dark Mode Preview"
          description={
            settings.theme === 'system'
              ? `System mode is currently ${systemPrefersDark ? 'Dark' : 'Light'}.`
              : `Orca is currently in ${settings.theme} mode.`
          }
          appearance={darkPreviewAppearance}
          dividerThicknessPx={paneStyleOptions.dividerThicknessPx}
          inactivePaneOpacity={paneStyleOptions.inactivePaneOpacity}
          activePaneOpacity={paneStyleOptions.activePaneOpacity}
        />
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4 px-1 py-2">
          <div className="space-y-0.5">
            <Label>Use Separate Theme In Light Mode</Label>
            <p className="text-xs text-muted-foreground">
              When disabled, light mode reuses the dark terminal theme.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.terminalUseSeparateLightTheme}
            onClick={() =>
              updateSettings({
                terminalUseSeparateLightTheme: !settings.terminalUseSeparateLightTheme
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.terminalUseSeparateLightTheme ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.terminalUseSeparateLightTheme ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div
          className={`grid overflow-hidden transition-all duration-300 ease-out ${
            settings.terminalUseSeparateLightTheme
              ? 'grid-rows-[1fr] opacity-100'
              : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0">
            <div className="grid gap-6 pt-2 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="space-y-6">
                <ThemePicker
                  label="Light Theme"
                  description="Choose the theme used when Orca is in light mode."
                  selectedTheme={settings.terminalThemeLight}
                  query={themeSearchLight}
                  onQueryChange={setThemeSearchLight}
                  onSelectTheme={(theme) => updateSettings({ terminalThemeLight: theme })}
                />

                <ColorField
                  label="Light Divider Color"
                  description="Controls the split divider line between panes in light mode."
                  value={settings.terminalDividerColorLight}
                  fallback="#d4d4d8"
                  onChange={(value) => updateSettings({ terminalDividerColorLight: value })}
                />
              </div>

              <TerminalThemePreview
                title="Light Mode Preview"
                description="Updates live as you change the light theme or divider color."
                appearance={lightPreviewAppearance}
                dividerThicknessPx={paneStyleOptions.dividerThicknessPx}
                inactivePaneOpacity={paneStyleOptions.inactivePaneOpacity}
                activePaneOpacity={paneStyleOptions.activePaneOpacity}
              />
            </div>
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Advanced</h2>
          <p className="text-xs text-muted-foreground">
            Scrollback is bounded for stability. This setting applies to new terminal panes.
          </p>
        </div>

        <div className="space-y-3">
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
        </div>
      </section>
    </div>
  )
}
