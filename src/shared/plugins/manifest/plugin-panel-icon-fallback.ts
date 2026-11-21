import { PLUGIN_PANEL_ICONS } from '../contributions/plugin-panel-contribution'
import { pluginPanelPathIconIssue } from '../contributions/plugin-panel-path-icon'
import { isPluginJsonObject } from './plugin-json-object'

const BUILT_IN_ICONS: ReadonlySet<string> = new Set(PLUGIN_PANEL_ICONS)

/** Why the icon cannot be drawn, or null when it is fine or the schema should judge it. */
function panelIconIssue(icon: unknown): string | null {
  if (typeof icon === 'string') {
    return !BUILT_IN_ICONS.has(icon) && /\.svg$/i.test(icon)
      ? 'file icons are not supported; use icon.path'
      : null
  }
  return isPluginJsonObject(icon) && !Array.isArray(icon) ? pluginPanelPathIconIssue(icon) : null
}

export function pluginPanelIconWarning(title: unknown, reason: string): string {
  const name = typeof title === 'string' ? title : ''
  return `Panel "${name}": icon isn't used (${reason}). Showing the puzzle icon instead.`
}

/** Drops format 2 panel icons Orca cannot draw, so the panel shows `puzzle` instead of the
 *  whole plugin failing to load. Other icon errors (a misspelled name) still fail the schema. */
export function withDrawablePluginPanelIcons(raw: unknown): { raw: unknown; warnings: string[] } {
  if (
    !isPluginJsonObject(raw) ||
    raw.manifestVersion !== 2 ||
    !isPluginJsonObject(raw.contributes) ||
    !Array.isArray(raw.contributes.panels)
  ) {
    return { raw, warnings: [] }
  }
  const warnings: string[] = []
  const panels = raw.contributes.panels.map((panel: unknown) => {
    if (!isPluginJsonObject(panel)) {
      return panel
    }
    const issue = panelIconIssue(panel.icon)
    if (!issue) {
      return panel
    }
    warnings.push(pluginPanelIconWarning(panel.title, issue))
    const { icon: _dropped, ...rest } = panel
    return rest
  })
  return warnings.length === 0
    ? { raw, warnings }
    : { raw: { ...raw, contributes: { ...raw.contributes, panels } }, warnings }
}
