import { z } from 'zod'
import {
  PLUGIN_CONTRIBUTION_POINTS,
  type PluginContributionPoint
} from './plugin-contribution-points'
import type { PluginManifest } from '../manifest/plugin-manifest'
import type { PluginFileMatch } from './plugin-file-match'
import { pluginFieldDoc, PLUGIN_MANIFEST_V2_SINCE } from '../manifest/plugin-schema-field-docs'

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
      // Why per item: a newer catalog's unknown kind must drop only that item, not the summary.
      .optional()
      .catch(undefined)
  )
  .max(PLUGIN_CONTRIBUTION_SUMMARY_LIMIT)
  .transform((items) => {
    const known = items.filter((item) => item !== undefined)
    // Nothing readable is unknown, not "adds nothing".
    return known.length === 0 && items.length > 0 ? undefined : known
  })

function fileMatchDetail(match: PluginFileMatch): string | undefined {
  return [...match.extensions, ...match.filenames].join(', ') || undefined
}

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
    ...named('themes', c.themes, (theme) => theme.title),
    ...named('terminalThemes', c.terminalThemes, (theme) => theme.title),
    ...named('iconThemes', c.iconThemes, (theme) => theme.title),
    ...named('syntaxes', c.syntaxes, (syntax) => syntax.title, fileMatchDetail),
    ...named('customEditors', c.customEditors, (editor) => editor.title, fileMatchDetail),
    ...named(
      'newFiles',
      c.newFiles,
      (newFile) => newFile.title,
      (newFile) => newFile.extension
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
