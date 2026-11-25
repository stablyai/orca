import {
  canonicalPluginPanelIcon,
  PLUGIN_PANEL_ICONS
} from '../contributions/plugin-panel-contribution'
import {
  PLUGIN_PANEL_PATH_ICON_STROKE_VIEW_BOX_MAX,
  pluginPanelPathIconIssue,
  resolvePluginPanelPathIcon
} from '../contributions/plugin-panel-path-icon'
import { stripUnsafeDisplayCharacters } from '../../text/display-text-safety'
import { orcaEngineRangeSchema, satisfiesOrcaEngineRange } from './plugin-manifest-engine-range'
import { isPluginJsonObject } from './plugin-json-object'
import { PLUGIN_PANEL_PATH_ICON_SINCE } from './plugin-schema-field-docs'

const BUILT_IN_ICONS: ReadonlySet<string> = new Set(PLUGIN_PANEL_ICONS)
// Why: warnings quote manifest text into logs and terminals; one line, no control characters.
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu

/** Manifest text quoted in a warning, safe to log on one line. */
function loggable(value: string): string {
  return stripUnsafeDisplayCharacters(value.replace(CONTROL_CHARACTERS, ' '))
}

function isObjectIcon(icon: unknown): icon is Record<PropertyKey, unknown> {
  return isPluginJsonObject(icon) && !Array.isArray(icon)
}

function isFileIcon(icon: unknown): icon is string {
  return typeof icon === 'string' && !BUILT_IN_ICONS.has(icon) && /\.svg$/i.test(icon)
}

/** Why the icon cannot be drawn, or null when it is fine or the schema should judge it. Only an
 *  object icon or an `.svg` string falls back; a misspelled name, null, an array or a number
 *  stays a schema error. */
function panelIconIssue(icon: unknown): string | null {
  if (isFileIcon(icon)) {
    return 'file icons are not supported; use icon.path'
  }
  return isObjectIcon(icon) ? pluginPanelPathIconIssue(icon) : null
}

function panelLabel(title: unknown): string {
  return `Panel "${typeof title === 'string' ? loggable(title) : ''}"`
}

export function pluginPanelIconWarning(title: unknown, reason: string): string {
  return `${panelLabel(title)}: icon isn't used (${loggable(reason)}). Showing the puzzle icon instead.`
}

/** A stroke icon drawn in a large viewBox: Lucide's 2-unit stroke assumes about 24 units. */
function thinStrokeWarning(title: unknown, icon: unknown): string | null {
  const resolved = resolvePluginPanelPathIcon(icon)
  if (!resolved || resolved.mode !== 'stroke') {
    return null
  }
  const [, , width, height] = resolved.viewBox.split(' ').map(Number)
  if (Math.max(width ?? 0, height ?? 0) <= PLUGIN_PANEL_PATH_ICON_STROKE_VIEW_BOX_MAX) {
    return null
  }
  return `${panelLabel(title)}: icon strokes are 2 units wide, sized for a viewBox of about 24, so they look thin in "${resolved.viewBox}". Scale the path to a 24-unit viewBox or use mode "fill".`
}

function rawPanels(raw: unknown): unknown[] {
  return isPluginJsonObject(raw) &&
    isPluginJsonObject(raw.contributes) &&
    Array.isArray(raw.contributes.panels)
    ? raw.contributes.panels
    : []
}

/** Format 1 drops every icon that isn't a built-in name; say so, since the panel shows `puzzle`. */
function legacyPanelIconWarnings(raw: unknown): string[] {
  return rawPanels(raw).flatMap((panel) => {
    if (!isPluginJsonObject(panel) || panel.icon === undefined) {
      return []
    }
    const { icon, title } = panel
    if (typeof icon === 'string' && canonicalPluginPanelIcon(icon)) {
      return []
    }
    const reason = isObjectIcon(icon)
      ? 'path icons require manifest format 2'
      : isFileIcon(icon)
        ? 'file icons are not supported; use icon.path with manifest format 2'
        : "isn't a built-in icon name"
    return [pluginPanelIconWarning(title, reason)]
  })
}

/** Drops format 2 panel icons Orca cannot draw, so the panel shows `puzzle` instead of the
 *  whole plugin failing to load, and warns about format 1 icons it drops on its own. */
export function withDrawablePluginPanelIcons(raw: unknown): { raw: unknown; warnings: string[] } {
  if (!isPluginJsonObject(raw) || raw.manifestVersion !== 2) {
    return { raw, warnings: isPluginJsonObject(raw) ? legacyPanelIconWarnings(raw) : [] }
  }
  const panels = rawPanels(raw)
  if (!isPluginJsonObject(raw.contributes) || panels.length === 0) {
    return { raw, warnings: [] }
  }
  const warnings: string[] = []
  let dropped = false
  const drawable = panels.map((panel: unknown) => {
    if (!isPluginJsonObject(panel)) {
      return panel
    }
    const issue = panelIconIssue(panel.icon)
    if (!issue) {
      const thin = thinStrokeWarning(panel.title, panel.icon)
      if (thin) {
        warnings.push(thin)
      }
      return panel
    }
    warnings.push(pluginPanelIconWarning(panel.title, issue))
    dropped = true
    const { icon: _dropped, ...rest } = panel
    return rest
  })
  return dropped
    ? { raw: { ...raw, contributes: { ...raw.contributes, panels: drawable } }, warnings }
    : { raw, warnings }
}

/** Why from the raw manifest: a dropped icon never reaches the engine-floor walk, yet Orca
 *  before the path icon release refuses any object or `.svg` icon, failing the whole plugin. */
export function pluginPanelIconEngineFloorError(raw: unknown): string | null {
  if (!isPluginJsonObject(raw) || raw.manifestVersion !== 2 || !isPluginJsonObject(raw.engines)) {
    return null
  }
  const declared = raw.engines.orca
  if (typeof declared !== 'string' || !orcaEngineRangeSchema.safeParse(declared).success) {
    return null
  }
  if (satisfiesOrcaEngineRange(declared.slice(2), `>=${PLUGIN_PANEL_PATH_ICON_SINCE}`)) {
    return null
  }
  const index = rawPanels(raw).findIndex(
    (panel) => isPluginJsonObject(panel) && (isObjectIcon(panel.icon) || isFileIcon(panel.icon))
  )
  return index === -1
    ? null
    : `engines.orca: must be at least >=${PLUGIN_PANEL_PATH_ICON_SINCE}, because contributes.panels[${index}].icon needs Orca ${PLUGIN_PANEL_PATH_ICON_SINCE}`
}
