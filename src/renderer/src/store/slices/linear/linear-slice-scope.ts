import type { AppState } from '../../types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import {
  canonicalizeLinearIssueAttributeFilter,
  isEmptyLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../../../../shared/linear/issue-attribute-filter'
import {
  getProviderRuntimeContextKey,
  getEnvironmentRuntimeContextKey
} from '@/lib/provider-runtime-context'
import { getLinearCacheGeneration, getLinearMutationGeneration } from './linear-slice-request-state'
import { defaultScopeSource, rowLessSourceTarget } from '@/lib/default-creation-host'
import type { RowLessSource } from '@/lib/default-creation-host'

export function normalizeListAttributeFilter(
  attributeFilter?: LinearIssueAttributeFilter | null
): LinearIssueAttributeFilter | undefined {
  if (!attributeFilter || isEmptyLinearIssueAttributeFilter(attributeFilter)) {
    return undefined
  }
  return canonicalizeLinearIssueAttributeFilter(attributeFilter)
}

export type LinearReadScope = {
  settings: RowLessSource
  contextKey: string
  runtimeContextKey: string
  cachePrefix: string | null
  explicitSource: boolean
  isCurrentRuntime: () => boolean
}

export function isCurrentLinearRuntimeContext(
  contextKey: string,
  settings: AppState['settings']
): boolean {
  return getProviderRuntimeContextKey(settings) === contextKey
}

export function canWriteLinearReadResult(
  contextKey: string,
  generation: number,
  mutationGeneration: number,
  settings: AppState['settings'],
  explicitSource = false
): boolean {
  return (
    generation === getLinearCacheGeneration() &&
    mutationGeneration === getLinearMutationGeneration() &&
    (explicitSource || isCurrentLinearRuntimeContext(contextKey, settings))
  )
}

export function getLinearReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): LinearReadScope {
  return getLinearSourceScope(sourceContext ?? defaultScopeSource(settings))
}

export function getLinearSourceScope(source: RowLessSource): LinearReadScope {
  const target = rowLessSourceTarget(source)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const runtimeKey = getEnvironmentRuntimeContextKey(environmentId)
  const cachePrefix = source.kind === 'task-source' ? getTaskSourceCacheScope(source) : null
  return {
    settings: source,
    runtimeContextKey: runtimeKey,
    contextKey: cachePrefix ? `${runtimeKey}::${cachePrefix}` : runtimeKey,
    cachePrefix,
    explicitSource: source.kind !== 'default-scope',
    isCurrentRuntime: () => getEnvironmentRuntimeContextKey(environmentId) === runtimeKey
  }
}

export function scopedLinearCacheKey(scope: LinearReadScope, key: string): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}

export function canPublishLinearScopeCache(
  scope: LinearReadScope,
  settings: AppState['settings']
): boolean {
  return (
    scope.isCurrentRuntime() &&
    (scope.cachePrefix !== null ||
      scope.runtimeContextKey === getProviderRuntimeContextKey(settings))
  )
}
