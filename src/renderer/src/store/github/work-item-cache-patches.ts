import type { GitHubTaskDeliveryWrite } from './task-read-reconciliation'
import { inheritScalarOrigins } from './work-item-patch-selectors'

import {
  bucketMatchesPatch,
  rowMatchesPatch,
  type PatchRequest,
  type PreparedPatch
} from './work-item-patch-selectors'

import { createTaskPageGitHubAuthorityProjection } from '@/components/task-page/github/task-page-github-work-item-mutation-composition'

import {
  listInput,
  type ListAddress,
  type ListInput
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import type { GitHubTaskFamily, GitHubTaskValueOrigin } from '@/lib/github-task-observation'

import {
  patchObservedGitHubWorkItem,
  createGitHubTaskObservationIndex
} from '@/lib/github-task-observation'

import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

import type { AppState } from '../types'

import type { GitHubPatchWorkItemOptions } from './cache-model'

import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'

import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'

import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'

export function prepareWorkItemPatches(
  s: AppState,
  requests: readonly PatchRequest[],
  indexed: boolean
) {
  const projection = createTaskPageGitHubAuthorityProjection()
  const deliveryWrites: GitHubTaskDeliveryWrite[] = []
  const existingEntryBaseObservations: { address: ListAddress; input: ListInput }[] = []
  const observationFor = createGitHubTaskObservationIndex(s.repos, () => null)
  const validated = new Map<
    NonNullable<GitHubPatchWorkItemOptions['observation']>,
    Map<string, boolean>
  >()
  const prepared: PreparedPatch[] = []
  // Scope -> renderer repo -> raw row -> canonical restriction. All indexes die with this call.
  const scopes = new Map<
    string | null,
    Map<string, Map<string, Map<string | null, PreparedPatch[]>>>
  >()
  requests.forEach((request, order) => {
    const { options } = request
    let currentObservation = true
    const sourceScope =
      options?.sourceContext?.provider === 'github'
        ? getTaskSourceCacheScope(options.sourceContext)
        : null
    if (options?.observation) {
      let owners = validated.get(options.observation)
      if (!owners) {
        validated.set(options.observation, (owners = new Map()))
      }
      const sourceKey = options.sourceContext ? getTaskSourceCacheScope(options.sourceContext) : ''
      if (!owners.has(sourceKey)) {
        owners.set(
          sourceKey,
          observationFor(
            { repoId: options.observation.repoId, repoHostId: options.observation.hostId },
            options.sourceContext
          )?.key === options.observation.key
        )
      }
      currentObservation = !!owners.get(sourceKey)
      if (
        !currentObservation &&
        !(
          options.listComposition?.length &&
          options.listComposition.every((plan) => plan.retirement) &&
          !Object.keys(request.patch).length
        )
      ) {
        return
      }
    }
    const sourceScopes =
      options?.sourceContexts?.map(getTaskSourceCacheScope) ?? (sourceScope ? [sourceScope] : [])
    const repositoryKey = options?.ownerRepo ? githubRepoIdentityKey(options.ownerRepo) : null
    let restrictions: Map<string | null, PreparedPatch[]> | undefined
    if (indexed && request.repoId) {
      let repos = scopes.get(sourceScope)
      if (!repos) {
        scopes.set(sourceScope, (repos = new Map()))
      }
      let rows = repos.get(request.repoId)
      if (!rows) {
        repos.set(request.repoId, (rows = new Map()))
      }
      restrictions = rows.get(request.itemId)
      if (!restrictions) {
        rows.set(request.itemId, (restrictions = new Map()))
      }
    }
    const next: PreparedPatch = {
      ...request,
      order,
      currentObservation,
      sourceScope,
      sourceScopes,
      repositoryKey,
      fields: new Map(),
      origins: new Map(),
      lists: []
    }
    for (const [field, value] of Object.entries(request.patch)) {
      if (field !== 'assignees' && field !== 'reviewRequests') {
        next.fields.set(field, { order, value })
      }
    }
    for (const family of ['assignees', 'reviewRequests'] as const) {
      const assigned = family in request.patch
      const hasOrigin = !!options?.valueOrigins && family in options.valueOrigins
      if (assigned || hasOrigin) {
        next.lists.push({
          order,
          family,
          assigned,
          hasOrigin,
          value: request.patch[family],
          origin: options?.valueOrigins?.[family]
        })
      }
    }
    for (const plan of options?.listComposition ?? []) {
      next.lists.push({ order, family: plan.address.family, plan })
    }
    for (const family of ['state', 'autoMerge'] as const) {
      if (options?.valueOrigins && family in options.valueOrigins) {
        next.origins.set(family, { order, value: options.valueOrigins[family] })
      }
    }
    prepared.push(next)
    if (restrictions) {
      const selectors = restrictions.get(repositoryKey) ?? []
      selectors.push(next)
      restrictions.set(repositoryKey, selectors)
    }
  })
  if (!prepared.length) {
    return { storePatch: s, existingEntryBaseObservations, deliveryWrites }
  }
  const destinations: (() => void)[] = []
  let nextCache: AppState['workItemsCache'] | undefined
  for (const [key, entry] of Object.entries(s.workItemsCache)) {
    if (!entry?.data) {
      continue
    }
    const bucketIndexes = indexed
      ? [null, ...[6, 7].map((n) => key.split(':').slice(0, n).join(':'))]
          .filter((scope, i, all) => all.indexOf(scope) === i)
          .flatMap((scope) => {
            const rows = scopes.get(scope)
            return rows ? [rows] : []
          })
      : []
    if (indexed && !bucketIndexes.length) {
      continue
    }
    const consumed = new Set<PreparedPatch>()
    let updatedItems: GitHubWorkItem[] | undefined
    entry.data.forEach((item, index) => {
      const candidates = indexed
        ? bucketIndexes.flatMap((repos) => {
            const restrictions = repos.get(item.repoId)?.get(item.id)
            if (!restrictions) {
              return []
            }
            const unrestricted = restrictions.get(null)
            const repository =
              restrictions.size > (unrestricted ? 1 : 0)
                ? parseGitHubIssueOrPRLink(item.url)?.slug
                : undefined
            const restricted = repository
              ? restrictions.get(githubRepoIdentityKey(repository))
              : undefined
            return [...(unrestricted ?? []), ...(restricted ?? [])]
          })
        : prepared
      const applicable = candidates.filter(
        (request) =>
          (!consumed.has(request) || !!request.options?.matches) &&
          bucketMatchesPatch(key, request) &&
          rowMatchesPatch(item, request)
      )
      if (!applicable.length) {
        return
      }
      const fields = new Map<string, { order: number; value: unknown }>()
      const originFields = new Map<
        GitHubTaskFamily,
        { order: number; value: GitHubTaskValueOrigin | undefined }
      >()
      for (const request of applicable) {
        consumed.add(request)
        for (const [field, value] of request.fields) {
          if ((fields.get(field)?.order ?? -1) <= value.order) {
            fields.set(field, value)
          }
        }
        for (const [family, value] of request.origins) {
          if ((originFields.get(family)?.order ?? -1) <= value.order) {
            originFields.set(family, value)
          }
        }
      }
      const patch: Partial<GitHubWorkItem> = Object.fromEntries(
        [...fields].map(([field, { value }]) => [field, value])
      )
      const origins: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin | undefined>> =
        Object.fromEntries([...originFields].map(([family, { value }]) => [family, value]))
      if (!indexed) {
        const request = applicable[0]
        inheritScalarOrigins(item, request, patch, origins)
      }
      const program = applicable
        .flatMap((request) => request.lists)
        .sort((a, b) => a.order - b.order)
      let ordinary = patchObservedGitHubWorkItem(item, patch, origins)
      for (const instruction of program) {
        const { family, plan } = instruction
        if (plan) {
          const input = listInput(ordinary, family, plan.address.observation)
          if (input.kind === 'full') {
            existingEntryBaseObservations.push({ address: plan.address, input })
            projection.observe(plan.address, input)
          }
        } else {
          ordinary = patchObservedGitHubWorkItem(
            ordinary,
            instruction.assigned ? { [family]: instruction.value } : {},
            instruction.hasOrigin ? { [family]: instruction.origin } : {}
          )
        }
      }
      destinations.push(() => {
        let updated =
          Object.keys(patch).length || Object.keys(origins).length
            ? patchObservedGitHubWorkItem(item, patch, origins)
            : item
        for (const instruction of program) {
          const { family, plan } = instruction
          updated = plan
            ? projection.list(updated, plan)
            : patchObservedGitHubWorkItem(
                updated,
                instruction.assigned ? { [family]: instruction.value } : {},
                instruction.hasOrigin ? { [family]: instruction.origin } : {}
              )
        }
        if (updated === item) {
          return
        }
        const written = (
          [
            'title',
            'state',
            'labels',
            'assignees',
            'author',
            'authorAvatarUrl',
            'updatedAt',
            'reviewRequests',
            'autoMergeEnabled'
          ] as const
        ).filter(
          (field) =>
            fields.has(field) ||
            program.some(
              (instruction) =>
                !instruction.plan && instruction.assigned && instruction.family === field
            )
        )
        if (written.length) {
          deliveryWrites.push({ before: item, after: updated, written })
        }
        updatedItems ??= [...entry.data!]
        updatedItems[index] = updated
        nextCache ??= { ...s.workItemsCache }
        nextCache[key] = { ...entry, data: updatedItems }
      })
    })
  }
  for (const commit of destinations) {
    commit()
  }
  return {
    storePatch: nextCache ? { workItemsCache: nextCache } : s,
    existingEntryBaseObservations,
    deliveryWrites
  }
}

export function reduceWorkItemPatches(...args: Parameters<typeof prepareWorkItemPatches>) {
  return prepareWorkItemPatches(...args).storePatch
}
