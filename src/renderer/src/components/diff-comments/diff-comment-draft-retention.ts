import { useEffect, useRef, type RefObject } from 'react'
import { setWithLRU } from '@/lib/scroll-cache'
import type { DiffCommentDraft } from './diff-comment-draft-zone'

type RetainedDiffCommentDraft = { draft: DiffCommentDraft; body: string }

const retainedDrafts = new Map<string, RetainedDiffCommentDraft>()

export function retainDiffCommentDraft(
  key: string | undefined,
  draft: RetainedDiffCommentDraft
): void {
  if (key) {
    setWithLRU(retainedDrafts, key, draft)
  }
}

export function retainTypedDiffCommentDraft(
  key: string | undefined,
  draft: RetainedDiffCommentDraft
): void {
  if (/\S/u.test(draft.body)) {
    retainDiffCommentDraft(key, draft)
  }
}

export function takeRetainedDiffCommentDraft(
  key: string | undefined
): RetainedDiffCommentDraft | null {
  if (!key) {
    return null
  }
  const draft = retainedDrafts.get(key) ?? null
  retainedDrafts.delete(key)
  return draft
}

export function clearRetainedDiffCommentDraft(key: string | undefined): void {
  if (key) {
    retainedDrafts.delete(key)
  }
}

// A carried draft belongs to the key it was typed under; its cleanup already stored it there.
function useDropPendingDraftOnKeyChange(
  key: string | undefined,
  pendingDraftRef: RefObject<RetainedDiffCommentDraft | null>,
  cancelReanchorFrame: () => void
): void {
  const previousKeyRef = useRef(key)
  useEffect(() => {
    if (previousKeyRef.current === key) {
      return
    }
    previousKeyRef.current = key
    cancelReanchorFrame()
    pendingDraftRef.current = null
  }, [cancelReanchorFrame, key, pendingDraftRef])
}

export function useRetainedDiffCommentDraft({
  key,
  editorReady,
  canOpenDraft,
  pendingDraftRef,
  scheduleReanchor,
  cancelReanchorFrame
}: {
  key: string | undefined
  editorReady: boolean
  canOpenDraft: boolean
  pendingDraftRef: RefObject<RetainedDiffCommentDraft | null>
  scheduleReanchor: () => void
  cancelReanchorFrame: () => void
}): void {
  useDropPendingDraftOnKeyChange(key, pendingDraftRef, cancelReanchorFrame)
  useEffect(() => {
    if (!editorReady || !canOpenDraft || pendingDraftRef.current) {
      return
    }
    const retained = takeRetainedDiffCommentDraft(key)
    if (!retained) {
      return
    }
    pendingDraftRef.current = retained
    scheduleReanchor()
    return () => {
      cancelReanchorFrame()
      // Teardown before the reanchor frame mounts the card must not strand the taken draft.
      if (pendingDraftRef.current === retained) {
        retainDiffCommentDraft(key, retained)
      }
    }
  }, [canOpenDraft, cancelReanchorFrame, editorReady, key, pendingDraftRef, scheduleReanchor])
}

export function useDiffCommentDraftModelReanchor({
  monacoModelIdentity,
  previousModelIdentityRef,
  key,
  draftZoneRef,
  pendingDraftRef,
  cancelReanchorFrame,
  disposeDraftZone,
  scheduleReanchor
}: {
  monacoModelIdentity: string | undefined
  previousModelIdentityRef: RefObject<string | undefined>
  key: string | undefined
  draftZoneRef: RefObject<(RetainedDiffCommentDraft & { submitting: boolean }) | null>
  pendingDraftRef: RefObject<RetainedDiffCommentDraft | null>
  cancelReanchorFrame: () => void
  disposeDraftZone: () => void
  scheduleReanchor: () => void
}): void {
  useEffect(() => {
    if (previousModelIdentityRef.current === monacoModelIdentity) {
      return
    }
    previousModelIdentityRef.current = monacoModelIdentity
    cancelReanchorFrame()
    const current = draftZoneRef.current
    if (current) {
      // In-flight saves restore their own failures; carrying their text would allow duplicate submission.
      if (!current.submitting) {
        const pending = { draft: current.draft, body: current.body }
        pendingDraftRef.current = pending
        retainTypedDiffCommentDraft(key, pending)
      }
      disposeDraftZone()
    }
    if (pendingDraftRef.current) {
      scheduleReanchor()
    }
  }, [
    cancelReanchorFrame,
    disposeDraftZone,
    draftZoneRef,
    key,
    monacoModelIdentity,
    pendingDraftRef,
    previousModelIdentityRef,
    scheduleReanchor
  ])
}
