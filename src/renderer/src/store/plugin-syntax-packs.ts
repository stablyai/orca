import {
  isPluginSyntaxMetadata,
  type PluginSyntaxMetadata
} from '../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { createPluginContentListStore } from './plugin-content-list-store'
import { prunePluginSyntaxFailures } from './plugin-syntax-failures'
import {
  matchPluginFile,
  pluginFileMatchRank
} from '../../../shared/plugins/contributions/plugin-file-match'

const syntaxes = createPluginContentListStore<PluginSyntaxMetadata>({
  kind: 'syntaxes',
  list: (api) => api.listSyntaxes,
  isEntry: isPluginSyntaxMetadata
})

export const usePluginSyntaxStore = syntaxes.useStore

// Why: an updated or removed plugin must not keep a failure for a revision that is gone.
usePluginSyntaxStore.subscribe((state) => {
  if (state.loaded) {
    prunePluginSyntaxFailures(state.entries)
  }
})
export const usePluginSyntaxes = syntaxes.useEntries

/** The plugin syntax for a file: an exact file name wins, then the longest extension, then the lower id. */
export function matchPluginSyntax(
  entries: readonly PluginSyntaxMetadata[],
  filePath: string
): PluginSyntaxMetadata | null {
  let best: PluginSyntaxMetadata | null = null
  let bestRank = 0
  for (const entry of entries) {
    const rank = pluginFileMatchRank(matchPluginFile(filePath, entry))
    // Why: plugin load order is not stable across restarts, so ties need a fixed winner.
    if (rank > bestRank || (rank > 0 && rank === bestRank && best && entry.id < best.id)) {
      best = entry
      bestRank = rank
    }
  }
  return best
}

// Core languages whose Monaco id drives more than coloring: language services or Markdown features.
const PLUGIN_PROTECTED_CORE_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'json',
  'css',
  'scss',
  'less',
  'html',
  'markdown'
])
// Orca maps these to a protected language only as a stopgap (JSP shown as HTML).
const PLUGIN_OVERRIDABLE_STOPGAP_EXTENSIONS = ['.jsp', '.jspf']

/** Whether a plugin syntax that claims this file may replace Orca's own language for it. */
export function canPluginSyntaxReplaceCoreLanguage(
  filePath: string,
  coreLanguage: string
): boolean {
  if (!PLUGIN_PROTECTED_CORE_LANGUAGES.has(coreLanguage)) {
    return true
  }
  const lowerPath = filePath.toLowerCase()
  return PLUGIN_OVERRIDABLE_STOPGAP_EXTENSIONS.some((extension) => lowerPath.endsWith(extension))
}

/** The plugin syntax that should color a file, or null to keep Orca's language. */
export function resolvePluginSyntaxForFile(
  entries: readonly PluginSyntaxMetadata[],
  filePath: string,
  coreLanguage: string
): PluginSyntaxMetadata | null {
  return canPluginSyntaxReplaceCoreLanguage(filePath, coreLanguage)
    ? matchPluginSyntax(entries, filePath)
    : null
}
