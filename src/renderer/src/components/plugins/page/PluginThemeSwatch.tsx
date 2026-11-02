import type { PluginThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-theme-artifact'

/** A two-tone chip of a theme's background and accent. */
export function ThemeColorSwatch({
  background,
  accent
}: {
  background: string
  accent: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex size-3.5 overflow-hidden rounded-sm ring-1 ring-border"
    >
      {/* Why inline colour: the swatch is the theme's own palette. */}
      <span className="flex-1" style={{ background }} />
      <span className="flex-1" style={{ background: accent }} />
    </span>
  )
}

/** The swatch of an installed plugin app theme. */
export function PluginThemeSwatch({
  theme
}: {
  theme: Pick<PluginThemeRegistration, 'tokens'>
}): React.JSX.Element {
  return (
    <ThemeColorSwatch
      background={theme.tokens['--background']}
      accent={theme.tokens['--primary'] ?? theme.tokens['--foreground']}
    />
  )
}
