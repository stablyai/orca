import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { canReadWorkspaceReferenceReview } from './workspace-reference-review-source'
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
  const requests = useMemo(
    () =>
      getWorkspaceAttachments(workspace).map((item) => ({
        ...getWorkspaceReferenceRequest(item, workspace, repo, runtimeVersion),
        knownProvider: review?.state ? review.provider : undefined
      })),
    [workspace, repo, runtimeVersion, review?.state, review?.provider]
  )
  useAppStore(
    useShallow((state) =>
      requests.map((request) => getWorkspaceReferenceLookup(request, state)?.rawEntry)
    )
  )
  useEffect(() => {
    if (!hoverOpen) {
      return
    }
    const controller = new AbortController()
    for (const request of requests) {
      void readWorkspaceReferenceDetails(request, controller.signal).catch(() => {})
    }
    return () => controller.abort()
  }, [requests, hoverOpen])
  const matching = requests.filter(
    (request) =>
      matchWorkspaceReferenceReview(request.item, review) &&
      canReadWorkspaceReferenceReview(request, review?.provider)
  )
  return Object.fromEntries(
    requests.map((request) => {
      const entry = getWorkspaceReferenceLookup(request, useAppStore.getState())?.entry
      const primary =
        review?.url && review.state && matching.length === 1 && matching[0] === request
          ? { title: review.title, url: review.url, review, stale: true }
          : undefined
      return [
        getWorkspaceAttachmentKey(request.item),
        entry ? (entry.data ? { ...entry.data, stale: entry.stale } : undefined) : primary
      ]
    })
  )
}
