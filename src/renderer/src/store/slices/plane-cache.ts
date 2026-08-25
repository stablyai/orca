import type { AppState } from '../types'
import type { CacheEntry } from './github'
import type {
  PlaneCollectionResult,
  PlaneCycle,
  PlaneEstimate,
  PlaneIssueQuery,
  PlaneLabel,
  PlaneMember,
  PlaneModule,
  PlaneProject,
  PlaneState,
  PlaneWorkItem,
  PlaneWorkItemType
} from '../../../../shared/plane/types'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'

export const PLANE_ISSUE_CACHE_TTL = 60_000
export const PLANE_METADATA_CACHE_TTL = 5 * 60_000
const MAX_CACHE_ENTRIES = 500

export type PlaneReadOptions = {
  sourceContext?: TaskSourceContext | null
  force?: boolean
}

export type PlaneReadScope = {
  settings: AppState['settings'] | TaskSourceContext | null
  contextKey: string
  cachePrefix: string | null
  explicitSource: boolean
}

export type InflightPlaneReadRequest<T> = {
  promise: Promise<T>
  contextKey: string
  mutationGeneration: number
  force: boolean
}

export type PlaneProjectResources = {
  states: PlaneState[]
  labels: PlaneLabel[]
  cycles: PlaneCycle[]
  modules: PlaneModule[]
  types: PlaneWorkItemType[]
  estimates: PlaneEstimate[]
}

let planeMutationGeneration = 0
export const inflightPlaneIssueLists = new Map<
  string,
  InflightPlaneReadRequest<PlaneCollectionResult<PlaneWorkItem>>
>()
export const inflightPlaneProjects = new Map<string, InflightPlaneReadRequest<PlaneProject[]>>()
export const inflightPlaneMembers = new Map<string, InflightPlaneReadRequest<PlaneMember[]>>()
export const inflightPlaneProjectResources = new Map<
  string,
  InflightPlaneReadRequest<PlaneProjectResources>
>()

export function emptyPlaneProjectResources(): PlaneProjectResources {
  return {
    states: [],
    labels: [],
    cycles: [],
    modules: [],
    types: [],
    estimates: []
  }
}

export function currentPlaneMutationGeneration(): number {
  return planeMutationGeneration
}

export function beginPlaneMutation(): void {
  planeMutationGeneration += 1
  clearPlaneInflight()
}

export function isFresh<T>(entry: CacheEntry<T> | undefined, ttl: number): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < ttl
}

export function evictStaleEntries<T>(
  cache: Record<string, CacheEntry<T>>,
  maxEntries = MAX_CACHE_ENTRIES
): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache)
  if (keys.length <= maxEntries) {
    return cache
  }
  const sorted = keys.sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
  const pruned: Record<string, CacheEntry<T>> = {}
  for (const key of sorted.slice(sorted.length - maxEntries)) {
    pruned[key] = cache[key]
  }
  return pruned
}

export function getPlaneReadScope(
  settings: AppState['settings'],
  sourceContext?: TaskSourceContext | null
): PlaneReadScope {
  if (!sourceContext) {
    return {
      settings,
      contextKey: getProviderRuntimeContextKey(settings),
      cachePrefix: null,
      explicitSource: false
    }
  }
  const runtimeSettings = getTaskSourceRuntimeSettings(sourceContext)
  return {
    settings: sourceContext,
    contextKey: `${getProviderRuntimeContextKey(runtimeSettings)}::${getTaskSourceCacheScope(sourceContext)}`,
    cachePrefix: getTaskSourceCacheScope(sourceContext),
    explicitSource: true
  }
}

export function scopedPlaneCacheKey(scope: PlaneReadScope, key: string): string {
  return `${scope.cachePrefix ?? scope.contextKey}::${key}`
}

function planeInstanceKey(instanceId?: string | null): string {
  return instanceId ?? 'selected'
}

function stablePlaneIssueQueryKey(query: PlaneIssueQuery): string {
  return JSON.stringify({
    preset: query.preset ?? null,
    query: query.query ?? null,
    projectId: query.projectId ?? null,
    projectIds: query.projectIds ?? null,
    stateGroup: query.stateGroup ?? null,
    stateGroups: query.stateGroups ?? null,
    stateId: query.stateId ?? null,
    stateIds: query.stateIds ?? null,
    priority: query.priority ?? null,
    priorities: query.priorities ?? null,
    assigneeId: query.assigneeId ?? null,
    assigneeIds: query.assigneeIds ?? null,
    labelId: query.labelId ?? null,
    labelIds: query.labelIds ?? null,
    cycleId: query.cycleId ?? null,
    moduleId: query.moduleId ?? null,
    typeId: query.typeId ?? null,
    estimatePoint: query.estimatePoint ?? null,
    orderBy: query.orderBy ?? null
  })
}

export function planeIssueListCacheKey(
  instanceId: string | undefined,
  query: PlaneIssueQuery,
  limit: number
): string {
  return `${planeInstanceKey(instanceId)}::issues::${limit}::${stablePlaneIssueQueryKey(query)}`
}

export function planeProjectsCacheKey(instanceId?: string): string {
  return `${planeInstanceKey(instanceId)}::projects`
}

export function planeMembersCacheKey(instanceId?: string): string {
  return `${planeInstanceKey(instanceId)}::members`
}

export function planeProjectResourcesCacheKey(
  instanceId: string | undefined,
  projectId: string
): string {
  return `${planeInstanceKey(instanceId)}::project-resources::${projectId}`
}

export function canWritePlaneReadResult(
  contextKey: string,
  mutationGeneration: number,
  settings: AppState['settings'],
  explicitSource = false
): boolean {
  return (
    mutationGeneration === planeMutationGeneration &&
    (explicitSource || getProviderRuntimeContextKey(settings) === contextKey)
  )
}

function clearPlaneInflight(): void {
  inflightPlaneIssueLists.clear()
  inflightPlaneProjects.clear()
  inflightPlaneMembers.clear()
  inflightPlaneProjectResources.clear()
}
