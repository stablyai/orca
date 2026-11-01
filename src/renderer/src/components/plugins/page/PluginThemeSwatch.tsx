import type { PluginThemeRegistration } from '../../../../../shared/plugins/artifacts/plugin-theme-artifact'

/** A two-tone chip of a plugin app theme's background and accent. */
export function PluginThemeSwatch({
  theme
}: {
  theme: Pick<PluginThemeRegistration, 'tokens'>
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex size-3.5 overflow-hidden rounded-sm ring-1 ring-border"
    >
      {/* Why inline colour: the swatch is the theme's own palette. */}
      <span className="flex-1" style={{ background: theme.tokens['--background'] }} />
      <span
        className="flex-1"
        style={{ background: theme.tokens['--primary'] ?? theme.tokens['--foreground'] }}
      />
    </span>
  )
}
