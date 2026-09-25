import { translate } from '@/i18n/i18n'
import type { PluginTaskScope } from '../../../../../shared/plugins/plugin-task-source-contract'

export function allProjectsLabel(): string {
  return translate('auto.components.TaskPage.pluginTaskSourceAllScopes', 'All projects')
}

/** Matches on `name` alone. The name is whatever the source called the scope —
 *  core must not split it into org and project to search the parts. */
export function filterPluginTaskScopes(
  scopes: readonly PluginTaskScope[],
  query: string
): PluginTaskScope[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return [...scopes]
  }
  return scopes.filter((scope) => scope.name.toLowerCase().includes(needle))
}

/** An id with no matching scope is ignored rather than shown raw: it is a
 *  provider-native string the user never saw. */
export function describePluginTaskScopeSelection(
  scopes: readonly PluginTaskScope[],
  selectedScopeIds: readonly string[]
): string {
  const selected = new Set(selectedScopeIds)
  const names = scopes.filter((scope) => selected.has(scope.id)).map((scope) => scope.name)
  if (names.length === 0) {
    return allProjectsLabel()
  }
  if (names.length === 1) {
    return names[0] ?? allProjectsLabel()
  }
  return translate('auto.components.TaskPage.pluginTaskSourceScopeCount', '{{value0}} projects', {
    value0: names.length
  })
}

export function togglePluginTaskScopeId(
  selectedScopeIds: readonly string[],
  scopeId: string
): string[] {
  return selectedScopeIds.includes(scopeId)
    ? selectedScopeIds.filter((id) => id !== scopeId)
    : [...selectedScopeIds, scopeId]
}
