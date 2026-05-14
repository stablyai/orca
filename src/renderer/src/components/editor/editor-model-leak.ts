// Why: kept Monaco diff models for both plain `mode === 'diff'` tabs and
// edit tabs in Changes view mode survive component unmount because of
// @monaco-editor/react's `keepCurrent*Model` flags. Tab close is the only
// signal we get that the user is done with these models. The URI scheme
// embeds the tab id, so a prefix match against `monaco.Uri.path` reliably
// finds every leaked model — including split-pane variants whose paths
// gain a `::${viewStateScopeId}` segment, and Changes-mode original models
// whose paths gain a `:original:${hash}` rotation segment.
//
// Why match against `uri.path` rather than `uri.toString()`: Monaco's
// `URI.toString()` percent-encodes `:` to `%3A`, but the constructed paths
// embed literal `:` as a delimiter. Comparing against `uri.path` keeps the
// predicate readable and avoids re-encoding the prefixes on every call.

export type DiffModelLeakMode = 'changes' | 'diff'

export type DiffModelCandidate = {
  scheme: string
  path: string
}

export function findLeakedDiffModelPaths(
  models: readonly DiffModelCandidate[],
  tabId: string,
  mode: DiffModelLeakMode
): string[] {
  const modifiedPrefix = `modified:${tabId}`
  const originalPrefix = `original:${tabId}`
  const out: string[] = []
  for (const { scheme, path } of models) {
    if (scheme !== 'diff') {
      continue
    }
    if (path === modifiedPrefix || path.startsWith(`${modifiedPrefix}::`)) {
      out.push(path)
      continue
    }
    if (mode === 'changes') {
      // Why: Changes mode rotates the original-side path by appending
      // `:original:${hash}` (single-pane) or `::${scope}:original:${hash}`
      // (split-pane). Both are caught by the trailing `:` prefix.
      if (path.startsWith(`${originalPrefix}:`)) {
        out.push(path)
      }
    } else {
      // Why: plain diff tabs use the original prefix exactly for single-pane
      // and `::${scope}` for split-pane. `::` is tighter than `:` and avoids
      // accidentally matching unrelated paths that happen to share a prefix.
      if (path === originalPrefix || path.startsWith(`${originalPrefix}::`)) {
        out.push(path)
      }
    }
  }
  return out
}
