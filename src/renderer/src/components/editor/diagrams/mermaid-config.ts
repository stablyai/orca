import type mermaid from 'mermaid'
import { hexToRgb, readableOn, rgbaToHex } from '../../../../../shared/color/rgba-contrast'
import { READABLE_CONTRAST } from '../../../../../shared/mermaid-flowchart-contrast'

export type MermaidThemeColors = {
  background: string
  foreground: string
  primary: string
  secondary: string
  tertiary: string
  border: string
}

export function getMermaidConfig(
  isDark: boolean,
  colors?: MermaidThemeColors
): Parameters<typeof mermaid.initialize>[0] {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    // The legacy dark theme removes color from flowcharts.
    theme: isDark ? (colors ? 'base' : 'dark') : 'default',
    darkMode: isDark,
    ...(isDark && colors ? { themeVariables: darkThemeVariables(colors) } : {}),
    // Strict mode sanitizes label HTML; sanitizeMermaidSvg keeps the foreignObject labels it emits.
    htmlLabels: true
  }
}

function darkThemeVariables(colors: MermaidThemeColors): Record<string, string | boolean> {
  // Mermaid draws dark-mode labels in the foreground colour, so darken a pastel chart token until it reads.
  const surface = (fill: string): string =>
    rgbaToHex(readableOn(hexToRgb(fill), [hexToRgb(colors.foreground)], true, READABLE_CONTRAST))
  // Seeds stay the theme's because git and venn pair them with their own label colours. Fills are
  // pinned only when tinted, so otherwise a diagram's own primaryColor/tertiaryColor still drives them.
  const tinted = (fill: string, keys: string[]): Record<string, string> => {
    const readable = surface(fill)
    return readable === fill.toLowerCase()
      ? {}
      : Object.fromEntries(keys.map((key) => [key, readable]))
  }
  return {
    darkMode: true,
    background: colors.background,
    primaryColor: colors.primary,
    secondaryColor: colors.secondary,
    tertiaryColor: colors.tertiary,
    ...tinted(colors.primary, [
      'mainBkg',
      'requirementBackground',
      'taskBkgColor',
      'tagLabelBackground'
    ]),
    ...tinted(colors.secondary, ['secondBkg']),
    ...tinted(colors.tertiary, ['clusterBkg', 'labelBackground']),
    primaryTextColor: colors.foreground,
    secondaryTextColor: colors.foreground,
    tertiaryTextColor: colors.foreground,
    primaryBorderColor: colors.border,
    secondaryBorderColor: colors.border,
    tertiaryBorderColor: colors.border,
    lineColor: colors.foreground,
    textColor: colors.foreground,
    edgeLabelBackground: colors.background,
    // Base defaults to light Gantt surfaces even when darkMode is enabled.
    altSectionBkgColor: colors.background,
    excludeBkgColor: colors.background,
    doneTaskBkgColor: colors.background,
    doneTaskBorderColor: colors.border,
    // Base's dark-blue clickable label is drawn for light bars, inside and beside the bar.
    taskTextClickableColor: colors.foreground,
    activeTaskBkgColor: surface(colors.secondary)
  }
}
