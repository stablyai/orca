import { create } from 'zustand'
import type { PluginSyntaxMetadata } from '../../../shared/plugins/artifacts/plugin-syntax-artifact'
import type { PluginGrammarFailure } from '@/lib/monaco-languages/plugin-grammar-worker-client'

type PluginSyntaxFailureState = {
  /** Failed grammars this session, keyed by `id@revision`; a plugin card says so only while
   *  that revision is still the installed one. */
  failures: Record<string, PluginGrammarFailure>
}

export const usePluginSyntaxFailureStore = create<PluginSyntaxFailureState>()(() => ({
  failures: {}
}))

/** The runtime slot key: a failure belongs to one revision, never to the syntax id alone. */
export function pluginSyntaxRevisionKey(
  syntax: Pick<PluginSyntaxMetadata, 'id' | 'revision'>
): string {
  return `${syntax.id}@${syntax.revision}`
}

export function recordPluginSyntaxFailure(revisionKey: string, reason: PluginGrammarFailure): void {
  if (usePluginSyntaxFailureStore.getState().failures[revisionKey]) {
    return
  }
  console.warn(`[plugins] ${revisionKey} shows plain text (${reason})`)
  usePluginSyntaxFailureStore.setState((state) => ({
    failures: { ...state.failures, [revisionKey]: reason }
  }))
}

/** Drops failures for revisions that are no longer installed. */
export function prunePluginSyntaxFailures(current: readonly PluginSyntaxMetadata[]): void {
  const live = new Set(current.map(pluginSyntaxRevisionKey))
  const { failures } = usePluginSyntaxFailureStore.getState()
  const kept = Object.entries(failures).filter(([key]) => live.has(key))
  if (kept.length !== Object.keys(failures).length) {
    usePluginSyntaxFailureStore.setState({ failures: Object.fromEntries(kept) })
  }
}
