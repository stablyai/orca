import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { canReadWorkspaceReferenceReview } from './workspace-reference-review-source'
import { useWslHostOffForRepo } from '../../use-wsl-host-off-review'
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

export function useWorkspaceReferenceDetails(
  workspace: Worktree,
  repo: Repo | undefined,
  review: WorktreeCardPrDisplay | null,
  hoverOpen: boolean
): WorkspaceReferenceDetailsMap {
  const runtimeVersion = getWorkspaceReferenceRuntimeVersion(workspace, repo)
  // Its WSL host is off: show what is cached as last known, and don't ask the host.
  const hostOff = useWslHostOffForRepo(repo)
  const requests = useMemo(
    () =>
      getWorkspaceAttachments(workspace).map((item) => ({
        ...getWorkspaceReferenceRequest(item, workspace, repo, runtimeVersion),
        knownProvider: review?.state ? review.provider : undefined
      })),
    [workspace, repo, runtimeVersion, review?.state, review?.provider]
  )
  const cacheReads = useMemo(
    () =>
      requests.map(
        (request) => getWorkspaceReferenceLookup(request, useAppStore.getState())?.getRawEntry
      ),
    [requests]
  )
  useAppStore(useShallow((state) => cacheReads.map((read) => read?.(state))))
  useEffect(() => {
    if (!hoverOpen || hostOff) {
      return
    }
    const controller = new AbortController()
    for (const request of requests) {
      void readWorkspaceReferenceDetails(request, controller.signal).catch(() => {})
    }
    return () => controller.abort()
  }, [requests, hoverOpen, hostOff])
  const matching = requests.filter(
    (request) =>
      matchWorkspaceReferenceReview(request.item, review) &&
      canReadWorkspaceReferenceReview(request, review?.provider)
  )
  return Object.fromEntries(
    requests.map((request) => {
      const entry = getWorkspaceReferenceLookup(request, useAppStore.getState())?.getEntry()
      const primary =
        review?.url && review.state && matching.length === 1 && matching[0] === request
          ? { title: review.title, url: review.url, review, stale: true }
          : undefined
      // Why: merged is terminal, so an older per-reference read must not show the card's merged review as open.
      const data =
        entry?.data?.review &&
        entry.data.review.state !== 'merged' &&
        review?.state === 'merged' &&
        matchWorkspaceReferenceReview(request.item, review)
          ? { ...entry.data, review }
          : entry?.data
      return [
        getWorkspaceAttachmentKey(request.item),
        entry ? (data ? { ...data, stale: entry.stale || hostOff } : undefined) : primary
      ]
    })
  )
}
