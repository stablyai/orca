import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { LigaturesAddon } from '@xterm/addon-ligatures'
import { Moon, Sun } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { buildFontFamily } from '@/lib/monospace-font-family'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { clampNumber, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { resolveTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { resolveTerminalLigaturesEnabled } from '../../../../shared/terminal-ligatures'
import { normalizeTerminalLineHeight } from '../../../../shared/terminal-line-height-settings'
import { PREVIEW_BUFFER } from './terminal-preview-content'
import { SettingsSwitch } from './SettingsFormControls'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'

// Pin 36 columns for the 32-character sample plus margin; large fonts clip instead of wrapping.
const PREVIEW_COLS = 36
const PREVIEW_ROWS = 15

// A narrow color-only stub demonstrates inactive opacity without crowding the sample.
const STUB_PANE_PX = 40

type PreviewMode = 'dark' | 'light'

type TerminalSettingsPreviewProps = {
  title: string
  description?: string
  settings: GlobalSettings
  systemPrefersDark: boolean
  /** Override for `settings.terminalFontFamily`; set by the font picker on hover to preview a font before committing. */
  previewFontFamily?: string | null
  /** Force the preview into this mode regardless of app settings; hides the in-header theme toggle when set. */
  modeOverride?: PreviewMode
  /** Render a Moon/Sun header toggle to flip the preview theme without changing the app theme. Ignored when `modeOverride` is set. */
  showThemeToggle?: boolean
}

function resolveAppMode(
  settings: Pick<GlobalSettings, 'theme'>,
  systemPrefersDark: boolean
): PreviewMode {
  if (settings.theme === 'system') {
    return systemPrefersDark ? 'dark' : 'light'
  }
  return settings.theme
}

export function TerminalSettingsPreview({
  title,
  description,
  settings,
  systemPrefersDark,
  previewFontFamily,
  modeOverride,
  showThemeToggle
}: TerminalSettingsPreviewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const ligaturesAddonRef = useRef<LigaturesAddon | null>(null)
  const skipInitialOptionMutationRef = useRef(false)
  const skipInitialThemeRewriteRef = useRef(false)

  const effectiveFontFamily = previewFontFamily || settings.terminalFontFamily
  const terminalLineHeight = normalizeTerminalLineHeight(settings.terminalLineHeight)

  // Seed from app theme once; preview toggles remain independent afterward.
  const [togglePreviewMode, setTogglePreviewMode] = useState<PreviewMode>(() =>
    resolveAppMode(settings, systemPrefersDark)
  )
  const [previewPaneDividerVisible, setPreviewPaneDividerVisible] = useState(false)

  const effectiveMode: PreviewMode =
    modeOverride ??
    (showThemeToggle ? togglePreviewMode : resolveAppMode(settings, systemPrefersDark))

  // Share live-pane appearance rules and list only relevant inputs so font/cursor edits avoid rederivation.
  const appearance = useMemo(
    () =>
      resolveEffectiveTerminalAppearance({ ...settings, theme: effectiveMode }, systemPrefersDark),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      effectiveMode,
      settings.terminalThemeDark,
      settings.terminalThemeLight,
      settings.terminalCustomThemes,
      settings.terminalUseSeparateLightTheme,
      settings.terminalDividerColorDark,
      settings.terminalDividerColorLight,
      systemPrefersDark
    ]
  )

  // List only theme-composition inputs so font/cursor changes cannot rewrite the sample buffer.
  const composedTheme = useMemo(
    () => composeActiveTerminalTheme(appearance.theme, settings),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      appearance,
      settings.terminalColorOverrides,
      settings.terminalBackgroundOpacity,
      settings.terminalCursorOpacity
    ]
  )

  const dividerThicknessPx = clampNumber(settings.terminalDividerThicknessPx, 1, 32)
  const inactivePaneOpacity = clampNumber(settings.terminalInactivePaneOpacity, 0, 1)
  const paneBackground = composedTheme?.background ?? '#000'

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const weights = resolveTerminalFontWeights(
      settings.terminalFontWeight,
      settings.terminalFontWeightBold
    )
    skipInitialOptionMutationRef.current = true
    skipInitialThemeRewriteRef.current = true
    // Use DOM rendering to spare scarce WebGL contexts; disableStdin reaches xterm’s internal textarea when wrapper attributes cannot.
    const terminal = new Terminal({
      ...buildDefaultTerminalOptions(),
      disableStdin: true,
      // Mirror inactive style because the unfocused preview would otherwise show xterm’s hollow outline.
      cursorInactiveStyle: settings.terminalCursorStyle,
      cursorStyle: settings.terminalCursorStyle,
      cursorBlink: settings.terminalCursorBlink,
      fontSize: settings.terminalFontSize,
      fontFamily: buildFontFamily(effectiveFontFamily),
      fontWeight: weights.fontWeight,
      fontWeightBold: weights.fontWeightBold,
      lineHeight: terminalLineHeight,
      theme: composedTheme ?? undefined,
      allowTransparency:
        settings.terminalBackgroundOpacity !== undefined && settings.terminalBackgroundOpacity < 1,
      cols: PREVIEW_COLS,
      rows: PREVIEW_ROWS
    })
    terminalRef.current = terminal

    try {
      terminal.open(container)
      terminal.write(PREVIEW_BUFFER)
    } catch (err) {
      terminalRef.current = null
      terminal.dispose()
      throw err
    }

    return () => {
      ligaturesAddonRef.current?.dispose()
      ligaturesAddonRef.current = null
      terminal.dispose()
      terminalRef.current = null
    }
    // Mount once; later changes flow through option-mutation effects.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mutate options for normal xterm repaint; pinned rows/cols need no refit.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    if (skipInitialOptionMutationRef.current) {
      skipInitialOptionMutationRef.current = false
      return
    }
    const weights = resolveTerminalFontWeights(
      settings.terminalFontWeight,
      settings.terminalFontWeightBold
    )
    terminal.options.fontSize = settings.terminalFontSize
    terminal.options.fontFamily = buildFontFamily(effectiveFontFamily)
    terminal.options.fontWeight = weights.fontWeight
    terminal.options.fontWeightBold = weights.fontWeightBold
    terminal.options.lineHeight = terminalLineHeight
    terminal.options.cursorStyle = settings.terminalCursorStyle
    // Mirror shape for the permanently unfocused preview cursor.
    terminal.options.cursorInactiveStyle = settings.terminalCursorStyle
    terminal.options.cursorBlink = settings.terminalCursorBlink
  }, [
    settings.terminalFontSize,
    settings.terminalFontWeightBold,
    effectiveFontFamily,
    settings.terminalFontWeight,
    terminalLineHeight,
    settings.terminalCursorStyle,
    settings.terminalCursorBlink
  ])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !composedTheme) {
      return
    }
    terminal.options.theme = composedTheme
    // Share live-pane contrast gating so preview behavior cannot drift (#7934).
    terminal.options.minimumContrastRatio = resolveTerminalMinimumContrastRatio(
      composedTheme.background,
      effectiveMode,
      settings.terminalMinimumContrastRatio
    )
    // xterm needs allowTransparency for alpha backgrounds, matching live panes.
    terminal.options.allowTransparency =
      settings.terminalBackgroundOpacity !== undefined && settings.terminalBackgroundOpacity < 1
    if (skipInitialThemeRewriteRef.current) {
      skipInitialThemeRewriteRef.current = false
      return
    }
    // Reset the mid-line sample; clear then write would duplicate its trailing fragment.
    terminal.reset()
    terminal.write(PREVIEW_BUFFER)
  }, [
    composedTheme,
    effectiveMode,
    settings.terminalBackgroundOpacity,
    settings.terminalMinimumContrastRatio
  ])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    const enabled = resolveTerminalLigaturesEnabled(settings.terminalLigatures, effectiveFontFamily)
    const current = ligaturesAddonRef.current
    if (enabled && !current) {
      const addon = new LigaturesAddon()
      try {
        terminal.loadAddon(addon)
        ligaturesAddonRef.current = addon
        // Repaint prewritten operators after loading ligatures.
        terminal.refresh(0, terminal.rows - 1)
      } catch (err) {
        addon.dispose()
        console.warn('[settings preview] ligatures addon failed to attach', err)
        ligaturesAddonRef.current = null
      }
    } else if (!enabled && current) {
      current.dispose()
      ligaturesAddonRef.current = null
    }
  }, [settings.terminalLigatures, effectiveFontFamily])

  const showToggle = showThemeToggle && modeOverride === undefined

  return (
    <Card className="gap-4 overflow-hidden py-0">
      <CardHeader className="gap-0 border-b border-border/50 px-4 py-3 !pb-3">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-sm">{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1">
              <span className="text-xs font-medium text-muted-foreground">
                {translate(
                  'auto.components.settings.TerminalSettingsPreview.50419052fe',
                  'Pane divider'
                )}
              </span>
              <SettingsSwitch
                checked={previewPaneDividerVisible}
                onChange={() => setPreviewPaneDividerVisible((visible) => !visible)}
                ariaLabel={translate(
                  'auto.components.settings.TerminalSettingsPreview.f8931d407d',
                  'Show pane divider in preview'
                )}
              />
            </div>
            {showToggle ? (
              <div
                className="flex gap-0.5 rounded-md border border-border/50 p-0.5"
                role="group"
                aria-label={translate(
                  'auto.components.settings.TerminalSettingsPreview.2c248fcc27',
                  'Preview theme'
                )}
              >
                {(['dark', 'light'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setTogglePreviewMode(mode)}
                    aria-pressed={togglePreviewMode === mode}
                    aria-label={translate(
                      'auto.components.settings.TerminalSettingsPreview.a63953a48a',
                      'Preview {{value0}} theme',
                      { value0: mode }
                    )}
                    title={translate(
                      'auto.components.settings.TerminalSettingsPreview.a63953a48a',
                      'Preview {{value0}} theme',
                      { value0: mode }
                    )}
                    className={`rounded-sm p-1 transition-colors ${
                      togglePreviewMode === mode
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {mode === 'dark' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {/* Keep opacity visible in the stub pane; opt-in dividers leave the default preview uncluttered. */}
        <div className="flex h-[300px] flex-col overflow-hidden rounded-md border border-border/50">
          <div className="flex min-h-0 flex-1 overflow-hidden" aria-hidden="true">
            <div
              ref={containerRef}
              className="min-w-0 flex-1 overflow-hidden p-2"
              style={{ backgroundColor: paneBackground }}
              tabIndex={-1}
            />
            {previewPaneDividerVisible ? (
              <div
                className="shrink-0"
                style={{
                  width: `${dividerThicknessPx}px`,
                  backgroundColor: appearance.dividerColor
                }}
              />
            ) : null}
            <div
              className="shrink-0"
              style={{
                width: `${STUB_PANE_PX}px`,
                backgroundColor: paneBackground,
                opacity: inactivePaneOpacity
              }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
