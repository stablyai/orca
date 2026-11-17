import type { PluginCatalogType } from '../../../../../shared/plugins/catalog/plugin-catalog-types'
import {
  derivePluginExecutionProfile,
  type PluginExecutionProfile
} from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import type { PluginManifest } from '../../../../../shared/plugins/manifest/plugin-manifest'

type PluginSafetySubject = {
  /** Orca's verified profile (installed list entry, catalog release or preview); null while unknown. */
  execution: PluginExecutionProfile | null
  /** The plugin's manifest once read; its contents must derive `data` too. */
  manifest?: Pick<PluginManifest, 'main' | 'capabilities' | 'contributes'> | null
}

/**
 * Whether nothing the plugin ships runs or acts for you (themes, icon themes, grammars, language
 * packs, file templates). Unknown is never safe. Tighten here only.
 */
export function isSafeContentOnlyPlugin({ execution, manifest }: PluginSafetySubject): boolean {
  if (execution !== 'data') {
    return false
  }
  // Why derive as well: the verified profile can be a v2 manifest's own claim.
  return !manifest || derivePluginExecutionProfile(manifest) === 'data'
}

/** What a non-official plugin's page and approvals must say about trusting its publisher. */
export type PluginPublisherNotice = 'none' | 'translations' | 'code'

export function pluginPublisherNotice(
  subject: PluginSafetySubject & {
    official: boolean
    /** Its catalog types; null when nothing verified says yet. */
    types: readonly PluginCatalogType[] | null
  }
): PluginPublisherNotice {
  if (subject.official) {
    return 'none'
  }
  if (!isSafeContentOnlyPlugin(subject)) {
    return 'code'
  }
  // Why translations still warn: they speak with Orca's voice and can reword any text in it.
  const translates = subject.manifest
    ? subject.manifest.contributes.languagePacks.length > 0
    : (subject.types?.includes('interface-language') ?? true)
  return translates ? 'translations' : 'none'
}
