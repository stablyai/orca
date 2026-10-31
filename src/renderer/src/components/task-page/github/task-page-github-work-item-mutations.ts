import {
  gitHubTaskFamilyOrigin,
  getGitHubTaskObservation,
  type GitHubTaskObservation
} from '@/lib/github-task-observation'

import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'

import {
  taskPageGitHubMutationItemId,
  taskPageGitHubItemKey
} from './task-page-github-work-item-mutation-keys'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'

import {
  buildTaskPageGitHubWorkItemMutationPatch,
  type TaskPageGitHubMutationIntent
} from './task-page-github-work-item-mutation-patches'

import {
  createTaskPageGitHubAuthorityProjection,
  familiesFromPendingOp,
  getRegistryMergedTaskPageGitHubWorkItem,
  establishTaskPageGitHubMembership
} from './task-page-github-work-item-mutation-composition'

import {
  beginListEntry,
  listInput,
  getPendingTaskPageGitHubOp,
  nextTaskPageGitHubMutationGeneration,
  notifyTaskPageGitHubMutationRegistry,
  setPendingTaskPageGitHubOp,
  setTaskPageGitHubMutationQueryKey
} from './task-page-github-work-item-mutation-registry'

import type {
  PendingOp,
  TaskPageGitHubMutationKey
} from './task-page-github-work-item-registry-types'

import type {
  BeginTaskPageGitHubWorkItemMutationArgs,
  BeginTaskPageGitHubWorkItemMutationResult
} from './task-page-github-work-item-mutation-types'

function resolveSourceScope(sourceContext?: TaskSourceContext | null): string | null {
  if (sourceContext?.provider === 'github') {
    return getTaskSourceCacheScope(sourceContext)
  }
  return null
}

function resolveTaskPageGitHubMutation(args: {
  item: GitHubWorkItem
  observation?: GitHubTaskObservation
  projection?: ReturnType<typeof createTaskPageGitHubAuthorityProjection>
  intent: TaskPageGitHubMutationIntent
  sourceContext?: TaskSourceContext | null
}) {
  const sourceScope = resolveSourceScope(args.sourceContext)
  const projection = args.projection ?? createTaskPageGitHubAuthorityProjection()
  const base = projection(args.item, sourceScope, args.observation)
  return {
    sourceScope,
    projection,
    built: buildTaskPageGitHubWorkItemMutationPatch(base, args.intent)
  }
}

export function canStartTaskPageGitHubWorkItemMutation(args: {
  item: GitHubWorkItem
  observation?: GitHubTaskObservation
  projection?: ReturnType<typeof createTaskPageGitHubAuthorityProjection>
  intent: TaskPageGitHubMutationIntent
  sourceContext?: TaskSourceContext | null
}): boolean {
  const { sourceScope, built, projection } = resolveTaskPageGitHubMutation(args)
  const itemId = taskPageGitHubMutationItemId(args.item)
  const key = {
    sourceScope,
    observation: args.observation ?? getGitHubTaskObservation(args.item),
    repoId: args.item.repoId,
    itemId,
    itemType: args.item.type,
    opKey: built.opKey
  }
  if (isTaskPageGitHubMutationPendingKey(key)) {
    return false
  }
  const pending = projection.pending(args.item, sourceScope, key.observation)
  if (built.kind === 'list') {
    const affectedLogins = new Set(built.listOp.logins)
    return !pending.some(
      (op) =>
        op.listOp?.family === built.family &&
        op.listOp.logins.some((login) => affectedLogins.has(login))
    )
  }
  return !pending.some(
    (op) =>
      !op.listOp && familiesFromPendingOp(op).some((family) => built.families.includes(family))
  )
}

export function beginTaskPageGitHubWorkItemMutation(
  args: BeginTaskPageGitHubWorkItemMutationArgs
): BeginTaskPageGitHubWorkItemMutationResult {
  ;(args.transitionQuery ?? setTaskPageGitHubMutationQueryKey)(args.queryKey)
  const { sourceScope, built } = resolveTaskPageGitHubMutation(args)
  const itemId = taskPageGitHubMutationItemId(args.item)
  const skipMeQualifiers = args.skipMeQualifiers ?? false
  const key = {
    sourceScope,
    observation: args.observation ?? getGitHubTaskObservation(args.item),
    repoId: args.item.repoId,
    itemId,
    itemType: args.item.type,
    opKey: built.opKey
  }
  const generation = nextTaskPageGitHubMutationGeneration(key)

  const previousItem = getRegistryMergedTaskPageGitHubWorkItem(
    args.item,
    sourceScope,
    key.observation
  )
  if (built.kind === 'list') {
    const address = { ...key, family: built.family }
    beginListEntry(
      address,
      args.resolveCurrentListInput?.(address, args.item) ??
        listInput(args.item, built.family, key.observation)
    )
  }
  const op: PendingOp = {
    generation,
    key,
    previous: built.previous,
    previousOrigins: Object.fromEntries(
      (['state', 'autoMerge', 'assignees', 'reviewRequests'] as const).map((family) => [
        family,
        gitHubTaskFamilyOrigin(previousItem, family)
      ])
    ),
    next: built.next,
    listOp: built.kind === 'list' ? built.listOp : undefined,
    skipMeQualifiers,
    startedAt: Date.now()
  }
  setPendingTaskPageGitHubOp(op)

  const merged = getRegistryMergedTaskPageGitHubWorkItem(args.item, sourceScope, args.observation)
  args.patchWorkItem(args.item.id, built.kind === 'list' ? {} : built.next, args.item.repoId, {
    sourceContext: args.sourceContext,
    ownerRepo:
      args.item.type === 'issue' ? parseGitHubIssueOrPRLink(args.item.url)?.slug : undefined,
    observation: key.observation,
    ...(built.kind === 'list'
      ? { listComposition: [{ address: { ...key, family: built.family } }] }
      : { valueOrigins: merged.githubValueOrigins })
  })

  establishTaskPageGitHubMembership({
    item: merged,
    sourceScope,
    queryKey: args.queryKey,
    skipMeQualifiers,
    observation: args.observation
  })
  notifyTaskPageGitHubMutationRegistry()

  return {
    generation,
    opKey: built.opKey,
    itemKey: taskPageGitHubItemKey(args.item.repoId, itemId),
    families: built.families,
    key
  }
}

export function isTaskPageGitHubMutationPendingKey(key: TaskPageGitHubMutationKey): boolean {
  return getPendingTaskPageGitHubOp(key) !== undefined
}
