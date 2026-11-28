import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import { getReadonlyWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { canReadWorkspaceReferenceReview } from './workspace-reference-review-source'
import { useWslHostOffForRepo } from './use-wsl-host-off-review'
import {
  getWorkspaceReferenceRequest,
  getWorkspaceReferenceRuntimeVersion,
  matchWorkspaceReferenceReview,
  type WorkspaceReferenceDetailsMap
} from './workspace-reference-details'
import {
  getWorkspaceReferenceLookup,
  readWorkspaceReferenceDetails
} from './workspace-reference-detail-read'

type ReferenceRequest = ReturnType<typeof getWorkspaceReferenceRequest> & {
  knownProvider: WorktreeCardPrDisplay['provider'] | undefined
}

type RawEntryReader = NonNullable<ReturnType<typeof getWorkspaceReferenceLookup>>['getRawEntry']

const EMPTY_REQUESTS: readonly ReferenceRequest[] = []
const EMPTY_CACHE_READS: readonly (RawEntryReader | undefined)[] = []
const EMPTY_CACHE_VALUES: readonly unknown[] = []
const EMPTY_REFERENCE_DETAILS: WorkspaceReferenceDetailsMap = {}
const getAppStoreState = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState()

export function useWorkspaceReferenceDetails(
  workspace: Worktree,
  repo: Repo | undefined,
  review: WorktreeCardPrDisplay | null,
  hoverOpen: boolean
): WorkspaceReferenceDetailsMap {
  const runtimeVersion = getWorkspaceReferenceRuntimeVersion(workspace, repo)
  // Its WSL host is off: show what is cached as last known, and don't ask the host.
  const hostOff = useWslHostOffForRepo(repo)
  const requests = useMemo((): readonly ReferenceRequest[] => {
    const attachments = getReadonlyWorkspaceAttachments(workspace)
    if (attachments.length === 0) {
      return EMPTY_REQUESTS
    }
    const knownProvider = review?.state ? review.provider : undefined
    return attachments.map((item) => ({
      ...getWorkspaceReferenceRequest(item, workspace, repo, runtimeVersion),
      knownProvider
    }))
  }, [workspace, repo, runtimeVersion, review?.state, review?.provider])
  const cacheReads = useMemo((): readonly (RawEntryReader | undefined)[] => {
    if (requests.length === 0) {
      return EMPTY_CACHE_READS
    }
    const state = getAppStoreState()
    return requests.map((request) => getWorkspaceReferenceLookup(request, state)?.getRawEntry)
  }, [requests])
  useAppStore(
    useShallow((state) =>
      cacheReads.length === 0 ? EMPTY_CACHE_VALUES : cacheReads.map((read) => read?.(state))
    )
  )
  useEffect(() => {
    if (!hoverOpen || hostOff || requests.length === 0) {
      return
    }
    const controller = new AbortController()
    for (const request of requests) {
      void readWorkspaceReferenceDetails(request, controller.signal).catch(() => {})
    }
    return () => controller.abort()
  }, [requests, hoverOpen, hostOff])
  if (requests.length === 0) {
    return EMPTY_REFERENCE_DETAILS
  }
  let singleMatch: ReferenceRequest | undefined
  if (review?.url && review.state) {
    let matchCount = 0
    for (const request of requests) {
      if (
        matchWorkspaceReferenceReview(request.item, review) &&
        canReadWorkspaceReferenceReview(request, review.provider)
      ) {
        matchCount += 1
        singleMatch = matchCount === 1 ? request : undefined
        if (matchCount > 1) {
          break
        }
      }
    }
  }
  const state = getAppStoreState()
  const result: Record<string, WorkspaceReferenceDetailsMap[string]> = {}
  for (const request of requests) {
    const entry = getWorkspaceReferenceLookup(request, state)?.getEntry()
    const primary =
      singleMatch === request && review?.url && review.state
        ? { title: review.title, url: review.url, review, stale: true }
        : undefined
    result[getWorkspaceAttachmentKey(request.item)] = entry
      ? entry.data
        ? { ...entry.data, stale: entry.stale || hostOff }
        : undefined
      : primary
  }
  return result
}
