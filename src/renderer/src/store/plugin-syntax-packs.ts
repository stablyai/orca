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

/** The plugin syntax for a file: an exact file name wins, then the longest extension. */
export function matchPluginSyntax(
  entries: readonly PluginSyntaxMetadata[],
  filePath: string
): PluginSyntaxMetadata | null {
  let best: PluginSyntaxMetadata | null = null
  let bestRank = 0
  for (const entry of entries) {
    const rank = pluginFileMatchRank(matchPluginFile(filePath, entry))
    if (rank > bestRank) {
      best = entry
      bestRank = rank
    }
  }
  return best
}
