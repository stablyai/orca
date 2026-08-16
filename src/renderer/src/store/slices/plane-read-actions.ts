import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PlaneSlice } from './plane'
import type {
  PlaneCollectionResult,
  PlaneMember,
  PlaneProject,
  PlaneWorkItem
} from '../../../../shared/plane/types'
import {
  planeListCycles,
  planeListEstimates,
  planeListIssues,
  planeListLabels,
  planeListMembers,
  planeListModules,
  planeListProjects,
  planeListStates,
  planeListWorkItemTypes
} from '@/runtime/runtime-plane-client'
import {
  PLANE_ISSUE_CACHE_TTL,
  PLANE_METADATA_CACHE_TTL,
  canWritePlaneReadResult,
  currentPlaneMutationGeneration,
  emptyPlaneProjectResources,
  evictStaleEntries,
  getPlaneReadScope,
  inflightPlaneIssueLists,
  inflightPlaneMembers,
  inflightPlaneProjectResources,
  inflightPlaneProjects,
  isFresh,
  planeIssueListCacheKey,
  planeMembersCacheKey,
  planeProjectResourcesCacheKey,
  planeProjectsCacheKey,
  scopedPlaneCacheKey,
  type InflightPlaneReadRequest,
  type PlaneProjectResources
} from './plane-cache'

type PlaneSliceSet = Parameters<StateCreator<AppState, [], [], PlaneSlice>>[0]
type PlaneSliceGet = Parameters<StateCreator<AppState, [], [], PlaneSlice>>[1]
type PlaneReadActions = Pick<
  PlaneSlice,
  'listPlaneIssues' | 'listPlaneProjects' | 'listPlaneMembers' | 'listPlaneProjectResources'
>

export function createPlaneReadActions(set: PlaneSliceSet, get: PlaneSliceGet): PlaneReadActions {
  return {
    listPlaneIssues: async (query, limit, instanceId, options) => {
      const scope = getPlaneReadScope(get().settings, options?.sourceContext)
      const cacheKey = scopedPlaneCacheKey(scope, planeIssueListCacheKey(instanceId, query, limit))
      const cached = get().planeIssueListCache[cacheKey]
      if (!options?.force && isFresh(cached, PLANE_ISSUE_CACHE_TTL)) {
        return cached.data ?? { items: [] }
      }
      const inflight = inflightPlaneIssueLists.get(cacheKey)
      if (inflight && canReuseInflight(scope.contextKey, inflight, options?.force)) {
        return inflight.promise
      }
      let entry: InflightPlaneReadRequest<PlaneCollectionResult<PlaneWorkItem>>
      const mutationGeneration = currentPlaneMutationGeneration()
      const promise = planeListIssues(scope.settings, query, limit, instanceId)
        .then((result) => {
          if (
            canWriteCache(get, cacheKey, entry, inflightPlaneIssueLists, scope, mutationGeneration)
          ) {
            set((s) => ({
              planeIssueListCache: evictStaleEntries({
                ...s.planeIssueListCache,
                [cacheKey]: { data: result, fetchedAt: Date.now() }
              })
            }))
          }
          return result
        })
        .catch((error) => {
          console.warn('[plane] listPlaneIssues failed:', error)
          return get().planeIssueListCache[cacheKey]?.data ?? { items: [] }
        })
        .finally(() => clearInflightEntry(inflightPlaneIssueLists, cacheKey, entry))
      entry = makeInflightEntry(promise, scope.contextKey, mutationGeneration, options?.force)
      inflightPlaneIssueLists.set(cacheKey, entry)
      return promise
    },

    listPlaneProjects: async (instanceId, options) => {
      const scope = getPlaneReadScope(get().settings, options?.sourceContext)
      const cacheKey = scopedPlaneCacheKey(scope, planeProjectsCacheKey(instanceId))
      const cached = get().planeProjectCache[cacheKey]
      if (!options?.force && isFresh(cached, PLANE_METADATA_CACHE_TTL)) {
        return cached.data ?? []
      }
      const inflight = inflightPlaneProjects.get(cacheKey)
      if (inflight && canReuseInflight(scope.contextKey, inflight, options?.force)) {
        return inflight.promise
      }
      return readPlaneProjects(set, get, scope, cacheKey, instanceId, options?.force)
    },

    listPlaneMembers: async (instanceId, options) => {
      const scope = getPlaneReadScope(get().settings, options?.sourceContext)
      const cacheKey = scopedPlaneCacheKey(scope, planeMembersCacheKey(instanceId))
      const cached = get().planeMemberCache[cacheKey]
      if (!options?.force && isFresh(cached, PLANE_METADATA_CACHE_TTL)) {
        return cached.data ?? []
      }
      const inflight = inflightPlaneMembers.get(cacheKey)
      if (inflight && canReuseInflight(scope.contextKey, inflight, options?.force)) {
        return inflight.promise
      }
      return readPlaneMembers(set, get, scope, cacheKey, instanceId, options?.force)
    },

    listPlaneProjectResources: async (projectId, instanceId, options) => {
      const scope = getPlaneReadScope(get().settings, options?.sourceContext)
      const cacheKey = scopedPlaneCacheKey(
        scope,
        planeProjectResourcesCacheKey(instanceId, projectId)
      )
      const cached = get().planeProjectResourceCache[cacheKey]
      if (!options?.force && isFresh(cached, PLANE_METADATA_CACHE_TTL)) {
        return cached.data ?? emptyPlaneProjectResources()
      }
      const inflight = inflightPlaneProjectResources.get(cacheKey)
      if (inflight && canReuseInflight(scope.contextKey, inflight, options?.force)) {
        return inflight.promise
      }
      return readPlaneProjectResources(
        set,
        get,
        scope,
        cacheKey,
        projectId,
        instanceId,
        options?.force
      )
    }
  }
}

type PlaneReadScope = ReturnType<typeof getPlaneReadScope>

function canReuseInflight<T>(
  contextKey: string,
  inflight: InflightPlaneReadRequest<T>,
  force = false
): boolean {
  return (
    inflight.contextKey === contextKey &&
    inflight.mutationGeneration === currentPlaneMutationGeneration() &&
    (!force || inflight.force)
  )
}

function makeInflightEntry<T>(
  promise: Promise<T>,
  contextKey: string,
  mutationGeneration: number,
  force = false
): InflightPlaneReadRequest<T> {
  return { promise, contextKey, mutationGeneration, force: Boolean(force) }
}

function clearInflightEntry<T>(
  inflightMap: Map<string, InflightPlaneReadRequest<T>>,
  cacheKey: string,
  entry: InflightPlaneReadRequest<T>
): void {
  if (inflightMap.get(cacheKey) === entry) {
    inflightMap.delete(cacheKey)
  }
}

function canWriteCache<T>(
  get: PlaneSliceGet,
  cacheKey: string,
  entry: InflightPlaneReadRequest<T>,
  inflightMap: Map<string, InflightPlaneReadRequest<T>>,
  scope: PlaneReadScope,
  mutationGeneration: number
): boolean {
  return (
    inflightMap.get(cacheKey) === entry &&
    canWritePlaneReadResult(
      scope.contextKey,
      mutationGeneration,
      get().settings,
      scope.explicitSource
    )
  )
}

function readPlaneProjects(
  set: PlaneSliceSet,
  get: PlaneSliceGet,
  scope: PlaneReadScope,
  cacheKey: string,
  instanceId: string | undefined,
  force = false
): Promise<PlaneProject[]> {
  let entry: InflightPlaneReadRequest<PlaneProject[]>
  const mutationGeneration = currentPlaneMutationGeneration()
  const promise = planeListProjects(scope.settings, instanceId)
    .then((projects) => {
      if (canWriteCache(get, cacheKey, entry, inflightPlaneProjects, scope, mutationGeneration)) {
        set((s) => ({
          planeProjectCache: evictStaleEntries({
            ...s.planeProjectCache,
            [cacheKey]: { data: projects, fetchedAt: Date.now() }
          })
        }))
      }
      return projects
    })
    .catch((error) => {
      console.warn('[plane] listPlaneProjects failed:', error)
      return get().planeProjectCache[cacheKey]?.data ?? []
    })
    .finally(() => clearInflightEntry(inflightPlaneProjects, cacheKey, entry))
  entry = makeInflightEntry(promise, scope.contextKey, mutationGeneration, force)
  inflightPlaneProjects.set(cacheKey, entry)
  return promise
}

function readPlaneMembers(
  set: PlaneSliceSet,
  get: PlaneSliceGet,
  scope: PlaneReadScope,
  cacheKey: string,
  instanceId: string | undefined,
  force = false
): Promise<PlaneMember[]> {
  let entry: InflightPlaneReadRequest<PlaneMember[]>
  const mutationGeneration = currentPlaneMutationGeneration()
  const promise = planeListMembers(scope.settings, instanceId)
    .then((members) => {
      if (canWriteCache(get, cacheKey, entry, inflightPlaneMembers, scope, mutationGeneration)) {
        set((s) => ({
          planeMemberCache: evictStaleEntries({
            ...s.planeMemberCache,
            [cacheKey]: { data: members, fetchedAt: Date.now() }
          })
        }))
      }
      return members
    })
    .catch((error) => {
      console.warn('[plane] listPlaneMembers failed:', error)
      return get().planeMemberCache[cacheKey]?.data ?? []
    })
    .finally(() => clearInflightEntry(inflightPlaneMembers, cacheKey, entry))
  entry = makeInflightEntry(promise, scope.contextKey, mutationGeneration, force)
  inflightPlaneMembers.set(cacheKey, entry)
  return promise
}

function readPlaneProjectResources(
  set: PlaneSliceSet,
  get: PlaneSliceGet,
  scope: PlaneReadScope,
  cacheKey: string,
  projectId: string,
  instanceId: string | undefined,
  force = false
): Promise<PlaneProjectResources> {
  let entry: InflightPlaneReadRequest<PlaneProjectResources>
  const mutationGeneration = currentPlaneMutationGeneration()
  const promise = Promise.all([
    planeListStates(scope.settings, projectId, instanceId),
    planeListLabels(scope.settings, projectId, instanceId),
    planeListCycles(scope.settings, projectId, instanceId),
    planeListModules(scope.settings, projectId, instanceId),
    planeListWorkItemTypes(scope.settings, projectId, instanceId),
    planeListEstimates(scope.settings, projectId, instanceId)
  ])
    .then(([states, labels, cycles, modules, types, estimates]) => {
      const resources = { states, labels, cycles, modules, types, estimates }
      if (
        canWriteCache(
          get,
          cacheKey,
          entry,
          inflightPlaneProjectResources,
          scope,
          mutationGeneration
        )
      ) {
        set((s) => ({
          planeProjectResourceCache: evictStaleEntries({
            ...s.planeProjectResourceCache,
            [cacheKey]: { data: resources, fetchedAt: Date.now() }
          })
        }))
      }
      return resources
    })
    .catch((error) => {
      console.warn('[plane] listPlaneProjectResources failed:', error)
      return get().planeProjectResourceCache[cacheKey]?.data ?? emptyPlaneProjectResources()
    })
    .finally(() => clearInflightEntry(inflightPlaneProjectResources, cacheKey, entry))
  entry = makeInflightEntry(promise, scope.contextKey, mutationGeneration, force)
  inflightPlaneProjectResources.set(cacheKey, entry)
  return promise
}
