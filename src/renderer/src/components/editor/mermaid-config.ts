import type mermaid from 'mermaid'
import {
  contrast,
  luminance,
  READABLE_CONTRAST
} from '../../../../shared/mermaid-flowchart-contrast'

export type MermaidThemeColors = {
  background: string
  foreground: string
  primary: string
  secondary: string
  tertiary: string
  border: string
}

function mixHex(from: string, to: string, amount: number): string {
  const channel = (hex: string, index: number): number =>
    Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16)
  return `#${[0, 1, 2]
    .map((index) => {
      const value = channel(from, index) + (channel(to, index) - channel(from, index)) * amount
      return Math.round(value).toString(16).padStart(2, '0')
    })
    .join('')}`
}

// Mermaid draws dark-mode labels in the foreground colour, so a pastel chart token would hide them;
// tint such a fill toward the background just until the label reads.
function readableFill(fill: string, foreground: string, background: string): string {
  const foregroundLuminance = luminance(foreground)
  if (foregroundLuminance === null) {
    return fill
  }
  for (let step = 0; step < 20; step++) {
    const mixed = mixHex(fill, background, step / 20)
    const fillLuminance = luminance(mixed)
    if (
      fillLuminance !== null &&
      contrast(foregroundLuminance, fillLuminance) >= READABLE_CONTRAST
    ) {
      return mixed
    }
  }
  return background
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
  const primary = readableFill(colors.primary, colors.foreground, colors.background)
  const secondary = readableFill(colors.secondary, colors.foreground, colors.background)
  const tertiary = readableFill(colors.tertiary, colors.foreground, colors.background)
  return {
    darkMode: true,
    background: colors.background,
    primaryColor: primary,
    secondaryColor: secondary,
    tertiaryColor: tertiary,
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
    activeTaskBkgColor: secondary
  }
}
