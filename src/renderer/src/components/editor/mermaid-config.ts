import type mermaid from 'mermaid'

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
  htmlLabels = false,
  colors?: MermaidThemeColors
): Parameters<typeof mermaid.initialize>[0] {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    // The legacy dark theme removes color from flowcharts.
    theme: isDark ? (colors ? 'base' : 'dark') : 'default',
    darkMode: isDark,
    ...(isDark && colors
      ? {
          themeVariables: {
            darkMode: true,
            background: colors.background,
            primaryColor: colors.primary,
            secondaryColor: colors.secondary,
            tertiaryColor: colors.tertiary,
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
            activeTaskBkgColor: colors.secondary
          }
        }
      : {}),
    htmlLabels
  }
}
