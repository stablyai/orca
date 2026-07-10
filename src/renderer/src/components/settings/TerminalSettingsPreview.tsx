import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { LigaturesAddon } from '@xterm/addon-ligatures'
import { Moon, Sun } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { buildFontFamily } from '@/components/terminal-pane/layout-serialization'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { clampNumber, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import { resolveTerminalLigaturesEnabled } from '../../../../shared/terminal-ligatures'
import { PREVIEW_BUFFER } from './terminal-preview-content'
import { SettingsSwitch } from './SettingsFormControls'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

// Why: pin cols/rows so PREVIEW_BUFFER never wraps. Sized so the longest
// line (the def total signature, 32 chars) plus a few cols of margin fits
// the xterm canvas in the xl right-column at the default 14px font with
// the divider + stub pane carved off the right side. Larger fonts will
// extend past the xterm box's right edge — the box clips, which is
// preferable to wrapping mid-content.
const PREVIEW_COLS = 36
const PREVIEW_ROWS = 15

// Why: the old TerminalThemePreview rendered two side-by-side panes so the
// user could see the divider + inactive opacity in context. Keep that
// affordance with a real xterm on the left and a small color-only stub on
// the right. 40px is wide enough to read the inactive opacity dim against
// the active xterm, narrow enough not to crowd content.
const STUB_PANE_PX = 40

type PreviewMode = 'dark' | 'light'

type TerminalSettingsPreviewProps = {
  title: string
  description?: string
  settings: GlobalSettings
  systemPrefersDark: boolean
  /** Optional override for `settings.terminalFontFamily`. Set by the font
   *  picker while the user hovers a dropdown option so they can preview a
   *  font without committing the selection. */
  previewFontFamily?: string | null
  /** Force the preview into this mode regardless of app settings. Used by
   *  the Dark/Light theme sections so each pins its own theme. When set,
   *  the in-header theme toggle is hidden. */
  modeOverride?: PreviewMode
  /** When true, render a Moon/Sun toggle in the card header so the user
   *  can flip the preview between dark and light themes without changing
   *  the app theme. Initial mode follows the active app theme. Ignored
   *  when `modeOverride` is set. */
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

  // Why: lazy-init from the active app theme so the toggle starts in the
  // user's current mode. After init the toggle is independent — flipping
  // it doesn't change app settings, and changing the app theme later
  // doesn't reset the toggle.
  const [togglePreviewMode, setTogglePreviewMode] = useState<PreviewMode>(() =>
    resolveAppMode(settings, systemPrefersDark)
  )
  const [previewPaneDividerVisible, setPreviewPaneDividerVisible] = useState(false)

  // Why: precedence — modeOverride pins the mode; otherwise the in-header
  // toggle drives it; otherwise follow whatever the app is set to right
  // now (recomputed each render so plain previews track app theme changes).
  const effectiveMode: PreviewMode =
    modeOverride ??
    (showThemeToggle ? togglePreviewMode : resolveAppMode(settings, systemPrefersDark))

  // Why: reuse the live-pane resolver so divider color, theme palette, and
  // the dark/light variant rules (e.g. `useSeparateLightTheme`) stay in
  // lockstep with what real terminal panes render.
  // Why: list each property resolveEffectiveTerminalAppearance reads instead
  // of the whole settings object so unrelated changes (font, cursor) don't
  // re-derive the appearance. The lint can't see that settings flows through
  // the helper to those specific properties.
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

  // Why: same — list the composeActiveTerminalTheme inputs explicitly so font
  // and cursor option changes don't trigger a buffer rewrite.
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
    const weights = resolveTerminalFontWeights(settings.terminalFontWeight)
    skipInitialOptionMutationRef.current = true
    skipInitialThemeRewriteRef.current = true
    // Why: DOM renderer only — multiple previews can mount at once and
    // WebGL contexts are scarce.
    // Why disableStdin: read-only preview. tabIndex/aria-hidden on the
    // wrapper don't reach xterm's internal textarea; disableStdin does.
    const terminal = new Terminal({
      ...buildDefaultTerminalOptions(),
      disableStdin: true,
      // Why mirror cursorInactiveStyle: xterm renders the cursor as a hollow
      // outline when the terminal is not focused. The preview is read-only and
      // never gets focused, so without mirroring the user wouldn't see their
      // selected cursor shape on the trailing prompt.
      cursorInactiveStyle: settings.terminalCursorStyle,
      cursorStyle: settings.terminalCursorStyle,
      cursorBlink: settings.terminalCursorBlink,
      fontSize: settings.terminalFontSize,
      fontFamily: buildFontFamily(effectiveFontFamily),
      fontWeight: weights.fontWeight,
      fontWeightBold: weights.fontWeightBold,
      lineHeight: settings.terminalLineHeight,
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
    // Why empty deps: mount effect intentionally runs once. Subsequent
    // setting changes (including cursor style) flow through the dedicated
    // option-mutation effects below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Why: font/cursor options are mutated directly so the preview repaints in
  // xterm's normal cycle. No fit/refit needed since cols/rows are pinned.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    if (skipInitialOptionMutationRef.current) {
      skipInitialOptionMutationRef.current = false
      return
    }
    const weights = resolveTerminalFontWeights(settings.terminalFontWeight)
    terminal.options.fontSize = settings.terminalFontSize
    terminal.options.fontFamily = buildFontFamily(effectiveFontFamily)
    terminal.options.fontWeight = weights.fontWeight
    terminal.options.fontWeightBold = weights.fontWeightBold
    terminal.options.lineHeight = settings.terminalLineHeight
    terminal.options.cursorStyle = settings.terminalCursorStyle
    // Why: see constructor — mirror so the unfocused cursor reflects the
    // user's chosen shape (xterm defaults inactive to 'outline').
    terminal.options.cursorInactiveStyle = settings.terminalCursorStyle
    terminal.options.cursorBlink = settings.terminalCursorBlink
  }, [
    settings.terminalFontSize,
    effectiveFontFamily,
    settings.terminalFontWeight,
    settings.terminalLineHeight,
    settings.terminalCursorStyle,
    settings.terminalCursorBlink
  ])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !composedTheme) {
      return
    }
    terminal.options.theme = composedTheme
    // Why: matches the live pane policy in applyTerminalAppearance — without
    // this, an opacity < 1 background renders opaque inside xterm even though
    // the theme color carries an alpha channel.
    terminal.options.allowTransparency =
      settings.terminalBackgroundOpacity !== undefined && settings.terminalBackgroundOpacity < 1
    if (skipInitialThemeRewriteRef.current) {
      skipInitialThemeRewriteRef.current = false
      return
    }
    // Why reset() not clear(): clear() keeps the row the cursor sits on, and
    // our buffer ends mid-line on the prompt — so a follow-up clear+write
    // would leave the trailing prompt fragment and append the new buffer
    // beneath it, producing the duplicated content seen during font swaps.
    // reset() restores cursor home + wipes the buffer so the rewrite starts
    // from a clean slate.
    terminal.reset()
    terminal.write(PREVIEW_BUFFER)
  }, [composedTheme, settings.terminalBackgroundOpacity])

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
        // Why: the preview writes its sample before this effect runs; repaint
        // so already-rendered operators switch to ligature glyphs immediately.
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
        {/* Why: flex layout with xterm on the left and a stub pane on the
            right keeps inactive-pane opacity visible. The divider stays
            preview-only and opt-in so the default preview remains clean. */}
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
