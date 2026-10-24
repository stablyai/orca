import { z } from 'zod'
import {
  PLUGIN_CONTRIBUTION_POINTS,
  type PluginContributionPoint
} from './plugin-contribution-points'
import type { PluginManifest } from './plugin-manifest'
import { pluginFieldDoc, PLUGIN_MANIFEST_V2_SINCE } from './plugin-schema-field-docs'

export const PLUGIN_CONTRIBUTION_SUMMARY_LIMIT = 64

export type PluginContributionSummaryItem = {
  kind: PluginContributionPoint
  name: string
  detail?: string
}

const NEXT = PLUGIN_MANIFEST_V2_SINCE

export const pluginContributionSummarySchema = z
  .array(
    z
      .object({
        kind: z
          .enum(PLUGIN_CONTRIBUTION_POINTS)
          .meta(pluginFieldDoc('Contribution point.', NEXT, ['themes'])),
        name: z
          .string()
          .min(1)
          .max(160)
          .meta(pluginFieldDoc('What the item is called in Orca.', NEXT, ['Dusk'])),
        detail: z
          .string()
          .min(1)
          .max(160)
          .optional()
          .meta(pluginFieldDoc('Extra context, such as file extensions.', NEXT))
      })
      .meta({ id: 'CatalogContribution', description: 'One thing the release adds to Orca.' })
  )
  .max(PLUGIN_CONTRIBUTION_SUMMARY_LIMIT)

/** What a manifest adds, as catalogs list it. Catalog CI generates the summary with this, and
 *  install compares a catalog's summary against it, so a listing cannot misstate a plugin. */
export function pluginContributionSummary(
  manifest: PluginManifest
): PluginContributionSummaryItem[] {
  const c = manifest.contributes
  const named = <Item>(
    kind: PluginContributionPoint,
    items: readonly Item[],
    name: (item: Item) => string,
    detail?: (item: Item) => string | undefined
  ) =>
    items.map((item) => {
      const extra = detail?.(item)
      return { kind, name: name(item), ...(extra ? { detail: extra } : {}) }
    })
  return [
    ...named('panels', c.panels, (panel) => panel.title),
    ...named('commands', c.commands, (command) => command.title),
    ...named('events', c.events, (event) => event.on),
    ...named('languagePacks', c.languagePacks, (pack) => pack.locale),
    ...named(
      'keybindings',
      c.keybindings,
      (binding) => binding.key,
      (binding) => binding.command
    ),
    ...named('vmRecipes', c.vmRecipes, (recipe) => recipe.path),
    ...named('agents', c.agents, (agent) => agent.path),
    ...named('themes', c.themes, (theme) => theme.label),
    ...named('terminalThemes', c.terminalThemes, (theme) => theme.label),
    ...named('iconThemes', c.iconThemes, (theme) => theme.label),
    ...named(
      'syntaxes',
      c.syntaxes,
      (syntax) => syntax.label,
      (syntax) => syntax.extensions.join(', ') || undefined
    )
  ].slice(0, PLUGIN_CONTRIBUTION_SUMMARY_LIMIT)
}

/** Order- and detail-insensitive identity of a summary, for comparing catalog and manifest. */
export function pluginContributionSummaryKey(
  items: readonly { kind: string; name: string }[]
): string {
  return items
    .map((item) => `${item.kind}\u0000${item.name}`)
    .sort()
    .join('\u0001')
}
