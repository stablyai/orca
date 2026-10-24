import { useMemo } from 'react'
import type { PluginMarketplaceHostListing } from '../../../../preload/api-types'
import { usePluginTerminalThemes, usePluginThemes } from '@/store/plugin-themes'
import type { PluginArtPalette } from '../plugin-catalog/PluginCardArt'

type CatalogThemePreview = NonNullable<
  NonNullable<PluginMarketplaceHostListing['release']>['themePreview']
>

/** A theme plugin's own colours: what Orca registered once installed, else the catalog's preview. */
export function usePluginArtPalettes(
  pluginKey: string,
  themePreview: CatalogThemePreview | undefined
): readonly PluginArtPalette[] {
  const appThemes = usePluginThemes()
  const terminalThemes = usePluginTerminalThemes()
  return useMemo(() => {
    const app = appThemes
      .filter((theme) => theme.pluginKey === pluginKey)
      .map((theme) => ({
        background: theme.tokens['--background'],
        foreground: theme.tokens['--foreground'],
        accent: theme.tokens['--primary'] ?? theme.tokens['--foreground'],
        muted: theme.tokens['--card'] ?? theme.tokens['--muted'] ?? theme.tokens['--background']
      }))
    if (app.length > 0) {
      return app
    }
    if (themePreview && themePreview.length > 0) {
      return themePreview.map((theme) => ({
        background: theme.background,
        foreground: theme.foreground,
        accent: theme.accent,
        muted: theme.surface
      }))
    }
    return terminalThemes
      .filter((theme) => theme.pluginKey === pluginKey && theme.terminal.background)
      .map((theme) => ({
        background: theme.terminal.background ?? '',
        foreground: theme.terminal.foreground ?? theme.terminal.white ?? '',
        accent: theme.terminal.magenta ?? theme.terminal.blue ?? theme.terminal.green ?? '',
        muted: theme.terminal.black ?? theme.terminal.background ?? ''
      }))
  }, [appThemes, terminalThemes, pluginKey, themePreview])
}
