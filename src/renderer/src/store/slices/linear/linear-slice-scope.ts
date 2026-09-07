import type { AppState } from '../../types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings
} from '../../../../../shared/task-source-context'
import {
  canonicalizeLinearIssueAttributeFilter,
  isEmptyLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../../../../shared/linear/issue-attribute-filter'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { getLinearCacheGeneration, getLinearMutationGeneration } from './linear-slice-request-state'

export function normalizeListAttributeFilter(
  attributeFilter?: LinearIssueAttributeFilter | null
): LinearIssueAttributeFilter | undefined {
  if (!attributeFilter || isEmptyLinearIssueAttributeFilter(attributeFilter)) {
    return undefined
  }
  return canonicalizeLinearIssueAttributeFilter(attributeFilter)
}

export type LinearReadScope = {
  settings: AppState['settings'] | TaskSourceContext | null
  contextKey: string
  cachePrefix: string | null
  explicitSource: boolean
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
  if (!sourceContext) {
    return {
      settings,
      contextKey: getProviderRuntimeContextKey(settings),
      cachePrefix: null,
      explicitSource: false
    }
  }
  const runtimeSettings = getTaskSourceRuntimeSettings(sourceContext)
  const cachePrefix = getTaskSourceCacheScope(sourceContext)
  return {
    settings: sourceContext,
    contextKey: `${getProviderRuntimeContextKey(runtimeSettings)}::${cachePrefix}`,
    cachePrefix,
    explicitSource: true
  }
}

export function scopedLinearCacheKey(scope: LinearReadScope, key: string): string {
  return scope.cachePrefix ? `${scope.cachePrefix}::${key}` : key
}
