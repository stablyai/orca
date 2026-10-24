import {
  isPluginSyntaxMetadata,
  type PluginSyntaxMetadata
} from '../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { createPluginContentListStore } from './plugin-content-list-store'
import { prunePluginSyntaxFailures } from './plugin-syntax-failures'

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
  const name = (filePath.split(/[\\/]/).at(-1) ?? '').toLowerCase()
  const byName = entries.find((entry) => entry.filenames.includes(name))
  if (byName) {
    return byName
  }
  let best: PluginSyntaxMetadata | null = null
  let bestLength = 0
  for (const entry of entries) {
    for (const extension of entry.extensions) {
      if (
        name.endsWith(extension) &&
        name.length > extension.length &&
        extension.length > bestLength
      ) {
        best = entry
        bestLength = extension.length
      }
    }
  }
  return best
}
