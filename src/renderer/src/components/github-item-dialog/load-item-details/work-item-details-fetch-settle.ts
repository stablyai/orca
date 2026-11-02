import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { GitHubTaskRecordCache, TaskBinding } from '@/store/github/task-record-cache'
import { githubTaskRpcOptions, type GitHubTaskTarget } from '@/lib/github-task-target'
import { useAppStore } from '@/store'
import { lookupGitHubWorkItemDetailsForSource } from '@/lib/github-work-item-source-lookup'
import {
  WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE,
  touchWorkItemDetailsCache,
  workItemDetailsCache,
  withWorkItemDetailsItem
} from './work-item-details-cache'

export async function loadCanonicalGitHubTaskDetails(
  cache: GitHubTaskRecordCache,
  binding: TaskBinding,
  target: GitHubTaskTarget,
  accepts: () => boolean
): Promise<GitHubWorkItemDetails | null> {
  const loaded: { details: GitHubWorkItemDetails | null } = { details: null }
  const accepted = await cache.readCanonical(target.item, binding, async (owned) => {
    // A failed required read is a failed Refresh, never an empty conversation or a raw message.
    loaded.details = await lookupGitHubWorkItemDetailsForSource({
      repoPath: target.repo.path,
      repoId: target.repo.id,
      sourceContext: target.source,
      type: 'issue',
      number: target.item.number,
      ownerRepo: target.ownerRepo,
      canonical: true,
      accepts: () => accepts() && owned(),
      rpcOptions: githubTaskRpcOptions(useAppStore.getState, binding.observation.fence)
    }).catch(() => null)
    return loaded.details && accepts() && owned()
      ? { ...target.item, ...loaded.details.item }
      : null
  })
  // Stored as read; the dialog adds pending edits when it renders.
  return accepted && loaded.details
    ? withWorkItemDetailsItem(loaded.details, { ...target.item, ...loaded.details.item })
    : null
}

/** An ordinary lenient load, pinned to the connection its binding was captured on. */
export async function loadOrdinaryWorkItemDetails(
  args: Omit<Parameters<typeof lookupGitHubWorkItemDetailsForSource>[0], 'number' | 'type'> & {
    item: GitHubWorkItem
  },
  cache: GitHubTaskRecordCache,
  binding: TaskBinding | undefined
): Promise<GitHubWorkItemDetails | null> {
  const { item, ...lookup } = args
  const result = await lookupGitHubWorkItemDetailsForSource({
    ...lookup,
    number: item.number,
    type: item.type,
    ...(binding && {
      rpcOptions: githubTaskRpcOptions(useAppStore.getState, binding.observation.fence)
    })
  })
  return result && binding
    ? withWorkItemDetailsItem(result, cache.acceptSearch([{ ...item, ...result.item }], binding)[0])
    : result
}

type FetchAcceptance = {
  /** A user-started read reports its own failure, so it never installs an inline load error. */
  userAction?: boolean
  accepts?: (result: GitHubWorkItemDetails | null) => boolean
  onAccepted?: (result: GitHubWorkItemDetails) => void
}
export async function settleWorkItemDetailsFetch(
  args: FetchAcceptance & {
    detailsCacheKey: string
    inflight: Promise<GitHubWorkItemDetails | null>
  }
) {
  const { detailsCacheKey, inflight } = args
  let result: GitHubWorkItemDetails | null = null
  let error: string | undefined
  try {
    result = await inflight
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load details'
  }
  const prev = workItemDetailsCache.get(detailsCacheKey)
  if (prev?.pending !== inflight) {
    return { status: 'superseded' } as const
  }
  try {
    if (args.accepts?.(result) === false) {
      touchWorkItemDetailsCache(detailsCacheKey, { ...prev, pending: undefined })
      return { status: 'superseded' } as const
    }
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load details'
    result = null
  }
  if (error || result === null) {
    // An ordinary unavailable response keeps existing detail without introducing an error.
    touchWorkItemDetailsCache(detailsCacheKey, {
      ...prev,
      pending: undefined,
      ...(args.userAction
        ? {}
        : { error: error ?? (prev.details ? undefined : WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE) })
    })
    return { status: 'failed', error: error ?? WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE } as const
  }
  touchWorkItemDetailsCache(detailsCacheKey, {
    ...prev,
    details: result,
    pending: undefined,
    error: undefined,
    fetchedAt: Date.now()
  })
  args.onAccepted?.(result)
  return { status: 'accepted', details: result } as const
}

export function startWorkItemDetailsFetch(
  key: string,
  load: () => Promise<GitHubWorkItemDetails | null>,
  options: FetchAcceptance = {}
) {
  const inflight = Promise.resolve().then(load)
  const previous = workItemDetailsCache.get(key)
  touchWorkItemDetailsCache(key, {
    details: previous?.details ?? null,
    fetchedAt: previous?.fetchedAt ?? 0,
    pending: inflight,
    error: previous?.error
  })
  const settled = settleWorkItemDetailsFetch({ ...options, detailsCacheKey: key, inflight })
  return {
    settled,
    pending: inflight,
    cancel() {
      const current = workItemDetailsCache.get(key)
      if (current?.pending === inflight) {
        touchWorkItemDetailsCache(key, { ...current, pending: undefined })
      }
    }
  }
}
