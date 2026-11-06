/** Theme id a plugin's live `appearance.apply` colors publish under for one mode. */
export function pluginRuntimeThemeId(
  pluginKey: string,
  base: 'dark' | 'light'
): `plugin:${string}/runtime-${'dark' | 'light'}` {
  return `plugin:${pluginKey}/runtime-${base}`
}

/** Whether a theme id names live plugin-published colors rather than a packaged theme. */
export function isPluginRuntimeThemeId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^plugin:[^/]+\/runtime-(?:dark|light)$/.test(id)
}
