import type * as Monaco from 'monaco-editor'
import type { PluginThemeTokenColorRule } from '../../../../../shared/plugins/artifacts/plugin-theme-artifact'
import { pluginMonacoTokenRules } from './plugin-monaco-token-rules'
import type { ColorProbe } from '../../../app-shell/appearance/plugin-theme-tokens'
import { contrastRatio, mix, over, type Rgba } from '../../../../../shared/color/rgba-contrast'

export type PluginMonacoTheme = { name: string; data: Monaco.editor.IStandaloneThemeData }

// The inherited built-in syntax colors are checked against the plugin's editor background.
// Why 3:1 for them: Monaco's own dark comment color is 4.2:1 on its own background.
const MIN_TEXT_CONTRAST = 4.5
export const MIN_SYNTAX_CONTRAST = 3
const BUILT_IN_SYNTAX: Record<'light' | 'dark', readonly string[]> = {
  // comment, string, keyword, type, number in vs / vs-dark.
  light: ['#008000', '#a31515', '#0000ff', '#008080', '#098658'],
  dark: ['#608b4e', '#ce9178', '#569cd6', '#3dc9b0', '#b5cea8']
}

// main.css --callout-note, used when an editor-only theme paints no link color.
const BUILT_IN_LINK: Record<'light' | 'dark', string> = {
  light: '#0969da',
  dark: '#4493f8'
}

// [Monaco color, token, hue the token follows when omitted]. Why only when the theme painted one:
// themes that set none keep Monaco's stock diff and link colors, exactly as before these tokens.
const MONACO_OPT_IN_COLORS: readonly (readonly [string, string, string])[] = [
  ...(['inserted', 'removed'] as const).flatMap((kind) => {
    const hue = kind === 'inserted' ? '--diff-added' : '--diff-removed'
    return [
      [`diffEditor.${kind}LineBackground`, `${hue}-background`, hue],
      [`diffEditor.${kind}TextBackground`, `${hue}-emphasis`, hue],
      [`diffEditorGutter.${kind}LineBackground`, `${hue}-gutter`, hue],
      [`diffEditorOverview.${kind}Foreground`, hue, hue]
    ] as const
  }),
  ['textLink.foreground', '--text-link', '--text-link'],
  ['textLink.activeForeground', '--text-link', '--text-link']
]

type AccentSurface = { readonly surface: Rgba; readonly percent: number }

/** Mix an accent deep enough to read as a surface without lowering foreground or syntax contrast. */
function accentSurface(args: {
  hue: Rgba
  background: Rgba
  foreground: Rgba
  syntaxColors: readonly Rgba[]
  percent: number
}): AccentSurface | null {
  for (let step = args.percent; step >= 10; step -= 2) {
    const surface = mix(args.hue, args.background, step)
    if (
      contrastRatio(surface, args.background) >= 1.2 &&
      contrastRatio(args.foreground, surface) >= MIN_TEXT_CONTRAST &&
      args.syntaxColors.every((color) => contrastRatio(color, surface) >= MIN_SYNTAX_CONTRAST)
    ) {
      return { surface, percent: step }
    }
  }
  return null
}

/** Monaco's find overlays are translucent so they do not hide decorations underneath. */
function accentOverlay(hue: Rgba, percent: number): Rgba {
  return [hue[0], hue[1], hue[2], percent / 100]
}

/** A find match also sits over the selection when Find navigates to it. */
function readableFindOverlay(
  overlay: Rgba,
  surfaces: readonly Rgba[],
  foreground: Rgba,
  syntaxColors: readonly Rgba[]
): boolean {
  return surfaces.every((surface) => {
    const composed = over(overlay, surface)
    return (
      contrastRatio(foreground, composed) >= MIN_TEXT_CONTRAST &&
      syntaxColors.every((color) => contrastRatio(color, composed) >= MIN_SYNTAX_CONTRAST)
    )
  })
}

function hex([r, g, b, a]: Rgba): string {
  const byte = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ''}`
}

/** A short stable hash, so a theme's name or revision changes with its content. */
export function hashThemeContent(text: string): string {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * A Monaco theme from the colors the document is actually painted with (plugin values, built-ins
 * where the plugin is silent), on the built-in light or dark syntax colors. Null when a color can't
 * be resolved or text and syntax colors would lose contrast; the editor then keeps its built-in
 * theme so a plugin theme can never make code unreadable.
 */
export function derivePluginMonacoTheme(input: {
  base: 'light' | 'dark'
  /** A document CSS variable's computed value. */
  read: (token: string) => string
  /** The tokens the theme painted, after the contrast check. */
  painted: Readonly<Record<string, string>>
  probe: ColorProbe
  tokenColors?: readonly PluginThemeTokenColorRule[]
}): PluginMonacoTheme | null {
  const color = (token: string): Rgba | null => {
    const value = input.read(token).trim()
    return value ? input.probe(value) : null
  }
  const background = color('--editor-surface') ?? color('--background')
  const foreground = color('--foreground')
  if (!background || background[3] < 1 || !foreground) {
    return null
  }
  if (
    contrastRatio(foreground, background) < MIN_TEXT_CONTRAST ||
    BUILT_IN_SYNTAX[input.base].some(
      (syntax) => contrastRatio(input.probe(syntax) ?? background, background) < MIN_SYNTAX_CONTRAST
    )
  ) {
    return null
  }
  const muted = color('--muted-foreground') ?? foreground
  const accent = color('--accent')
  const ring = color('--ring') ?? foreground
  const themed = input.painted['--editor-selection'] ? color('--editor-selection') : null
  const link =
    color('--text-link') ?? color('--callout-note') ?? input.probe(BUILT_IN_LINK[input.base])
  // Only custom foregrounds Monaco will actually paint should constrain the accent surfaces.
  const acceptedTokenForeground = (value: string): Rgba | null => {
    const parsed = input.probe(value)
    if (!parsed) {
      return null
    }
    const [r, g, b, a] = parsed
    const opaque: Rgba = [
      r * a + background[0] * (1 - a),
      g * a + background[1] * (1 - a),
      b * a + background[2] * (1 - a),
      1
    ]
    return contrastRatio(opaque, background) >= MIN_SYNTAX_CONTRAST ? opaque : null
  }
  const syntaxColors = [
    ...BUILT_IN_SYNTAX[input.base].flatMap((value) => {
      const syntax = input.probe(value)
      return syntax ? [syntax] : []
    }),
    ...(input.tokenColors ?? []).flatMap((rule) =>
      rule.settings.foreground ? [acceptedTokenForeground(rule.settings.foreground)] : []
    )
  ].filter((value): value is Rgba => value !== null)
  const selectionMix = input.base === 'dark' ? 34 : 28
  const accentSelection = link
    ? accentSurface({ hue: link, background, foreground, syntaxColors, percent: selectionMix })
    : null
  const selection: Rgba = themed ?? accentSelection?.surface ?? [ring[0], ring[1], ring[2], 0.3]
  const faded: Rgba = [selection[0], selection[1], selection[2], selection[3] / 2]
  // Why: the gate checks a theme's selection at full strength; halved, it can blend into a
  // mid-tone that hides the text, so an unfocused editor then keeps the full color.
  const inactive =
    !themed || contrastRatio(foreground, over(faded, background)) >= MIN_TEXT_CONTRAST
      ? faded
      : selection
  const searchMixes =
    input.base === 'dark' ? { inactive: 26, active: 50 } : { inactive: 22, active: 45 }
  const selectionSurface = over(selection, background)
  const inactiveSurface = over(inactive, background)
  const activeSurface = link
    ? accentSurface({
        hue: link,
        background,
        foreground,
        syntaxColors,
        percent: searchMixes.active
      })
    : null
  const inactiveSurfaceCandidate =
    link && activeSurface
      ? accentSurface({
          hue: link,
          background,
          foreground,
          syntaxColors,
          percent: Math.min(searchMixes.inactive, activeSurface.percent - 2)
        })
      : null
  const findSurfaces = [selectionSurface, inactiveSurface]
  const searchActive =
    link &&
    activeSurface &&
    readableFindOverlay(
      accentOverlay(link, activeSurface.percent),
      findSurfaces,
      foreground,
      syntaxColors
    )
      ? activeSurface
      : null
  const searchInactive =
    link &&
    inactiveSurfaceCandidate &&
    readableFindOverlay(
      accentOverlay(link, inactiveSurfaceCandidate.percent),
      findSurfaces,
      foreground,
      syntaxColors
    )
      ? inactiveSurfaceCandidate
      : null
  const popover = color('--popover')
  const border = color('--border')
  const colors: Record<string, string> = {
    'editor.background': hex(background),
    'editor.foreground': hex(foreground),
    'editorGutter.background': hex(background),
    'minimap.background': hex(background),
    'editorLineNumber.foreground': hex(muted),
    'editorLineNumber.activeForeground': hex(foreground),
    'editorCursor.foreground': hex(ring),
    'editor.selectionBackground': hex(selection),
    'editor.inactiveSelectionBackground': hex(inactive)
  }
  if (accent) {
    colors['editor.lineHighlightBackground'] = hex(accent)
  }
  if (searchActive && searchInactive && link) {
    colors['editor.findMatchHighlightBackground'] = hex(accentOverlay(link, searchInactive.percent))
    colors['editor.findMatchBackground'] = hex(accentOverlay(link, searchActive.percent))
  }
  if (popover) {
    colors['editorWidget.background'] = hex(popover)
    colors['editorSuggestWidget.background'] = hex(popover)
  }
  if (border) {
    colors['editorWidget.border'] = hex(border)
  }
  for (const [key, token, hue] of MONACO_OPT_IN_COLORS) {
    const value = input.painted[token] || input.painted[hue] ? color(token) : null
    if (value) {
      colors[key] = hex(value)
    }
  }
  const data: Monaco.editor.IStandaloneThemeData = {
    base: input.base === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: pluginMonacoTokenRules(input.tokenColors ?? [], (value) => {
      const opaque = acceptedTokenForeground(value)
      return opaque ? hex(opaque) : null
    }),
    colors
  }
  return { name: `orca-plugin-${hashThemeContent(JSON.stringify(data))}`, data }
}
