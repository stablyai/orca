import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  addNativeChatDraftAttachments,
  clearNativeChatDraftAttachments,
  readNativeChatDraftAttachments,
  removeNativeChatDraftAttachment,
  settleNativeChatDraftAttachment,
  subscribeToNativeChatDraft,
  type NativeChatDraftChip
} from './native-chat-draft-cache'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import { findMissingNativeChatAttachments } from './native-chat-attachment-existence'
import { useNativeChatResolvedPathAttachments } from './use-native-chat-resolved-path-attachments'

export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
  allowWithoutTarget?: boolean
  caret: number
  disabled: boolean
  isComposing: () => boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  textareaRef: RefObject<NativeChatComposerInput | null>
  setCaret: (caret: number) => void
  setDraft: (updater: (previous: string) => string) => void
  setNotice: (notice: string | null) => void
}

export function useNativeChatComposerAttachments({
  attachmentScopeKey,
  allowWithoutTarget = false,
  caret,
  disabled,
  isComposing,
  resolveTarget,
  textareaRef,
  setCaret,
  setDraft,
  setNotice
}: UseNativeChatComposerAttachmentsArgs): {
  imageAttachments: NativeChatComposerImageAttachment[]
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  clearImageAttachments: () => void
  flushPendingAttachments: () => void
  removeImageAttachment: (id: string) => void
  beginPendingImageAttachment: (previewUrl?: string) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  dropPendingImageAttachment: (id: string) => void
} {
  // Clipboard thumbnails of chips pasted in this view; the chips themselves are the chat's.
  const previewsRef = useRef(new Map<string, string>())
  const [shared, setShared] = useState(() => readNativeChatDraftAttachments(attachmentScopeKey))
  // Chips this view has checked or attached itself; anything else may be restored from disk.
  const checkedIdsRef = useRef(new Set<string>())
  const [missingIds, setMissingIds] = useState<ReadonlySet<string>>(() => new Set())
  // Restored chips whose read grant and check are still running; their previews wait for both.
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(() => new Set())

  // A saved draft can outlive its image (age sweep, OS temp cleanup), so each restored chip is
  // checked once; a missing one is shown as such and blocks Send, rather than sending a dead path.
  useEffect(() => {
    const unchecked = shared.filter(
      (attachment) => !attachment.pending && !checkedIdsRef.current.has(attachment.id)
    )
    if (unchecked.length === 0) {
      return
    }
    const ids = new Set(unchecked.map((attachment) => attachment.id))
    ids.forEach((id) => checkedIdsRef.current.add(id))
    setCheckingIds((previous) => new Set([...previous, ...ids]))
    void findMissingNativeChatAttachments(unchecked).then((missing) => {
      if (missing.size > 0) {
        setMissingIds((previous) => new Set([...previous, ...missing]))
      }
      setCheckingIds((previous) => new Set([...previous].filter((id) => !ids.has(id))))
    })
  }, [shared])

  useEffect(() => {
    const previews = previewsRef.current
    const showShared = (): void => {
      const next = readNativeChatDraftAttachments(attachmentScopeKey)
      const ids = new Set(next.map((chip) => chip.id))
      for (const [id, previewUrl] of previews) {
        if (!ids.has(id)) {
          releasePreviewUrl(previewUrl)
          previews.delete(id)
        }
      }
      setShared(next)
    }
    const unsubscribe = subscribeToNativeChatDraft(attachmentScopeKey, showShared)
    // A write between this view's render and its subscription would otherwise never show here.
    showShared()
    return () => {
      unsubscribe()
      // Previews die with the view that holds them; other views read the chip from its path.
      previews.forEach(releasePreviewUrl)
      previews.clear()
    }
  }, [attachmentScopeKey])

  // Every view of the chat attaches into one list, so ids must not repeat across views.
  const nextAttachmentId = useCallback((): string => createBrowserUuid(), [])

  // Client-local paths cannot cross into a runtime target; workspace-owned
  // paths may only bypass this after the internal drop ownership gate.
  const attachmentTargetBlocked = useCallback(
    (targetOwned = false): boolean => {
      const target = resolveTarget()
      return (
        (!target && !allowWithoutTarget) ||
        Boolean(target && nativeChatComposerTargetIsRemote(target.ptyId) && !targetOwned)
      )
    },
    [allowWithoutTarget, resolveTarget]
  )

  const noteAttachmentTargetBlocked = useCallback(() => {
    setNotice(
      translate(
        'components.native-chat.composer.localAttachmentUnsupported',
        'Local attachments are not available for remote sessions.'
      )
    )
  }, [setNotice])

  const appendImageAttachments = useCallback(
    (paths: { path: string; connectionId?: string | null; onRuntimeHost?: boolean }[]) => {
      if (paths.length === 0) {
        return
      }
      const attached = paths.map(({ path, connectionId, onRuntimeHost }) =>
        settledChip(nextAttachmentId(), path, connectionId, onRuntimeHost)
      )
      attached.forEach(({ id }) => checkedIdsRef.current.add(id))
      addNativeChatDraftAttachments(attachmentScopeKey, attached)
    },
    [attachmentScopeKey, nextAttachmentId]
  )

  const { attachResolvedPaths, disabledRef, flushPendingAttachments } =
    useNativeChatResolvedPathAttachments({
      appendImageAttachments,
      attachmentTargetBlocked,
      caret,
      disabled,
      isComposing,
      noteAttachmentTargetBlocked,
      setCaret,
      setDraft,
      setNotice,
      textareaRef
    })

  // Placeholder chip shown the instant a paste starts, so a clipboard image that
  // takes a beat to save (or upload over SSH) never reads as a dropped paste.
  const beginPendingImageAttachment = useCallback(
    (previewUrl?: string): string | null => {
      if (disabledRef.current) {
        return null
      }
      if (attachmentTargetBlocked()) {
        noteAttachmentTargetBlocked()
        return null
      }
      const id = nextAttachmentId()
      if (previewUrl) {
        previewsRef.current.set(id, previewUrl)
      }
      addNativeChatDraftAttachments(attachmentScopeKey, [{ id, path: '', pending: true }])
      return id
    },
    [
      attachmentScopeKey,
      attachmentTargetBlocked,
      disabledRef,
      nextAttachmentId,
      noteAttachmentTargetBlocked
    ]
  )

  const resolvePendingImageAttachment = useCallback(
    (id: string, path: string, connectionId?: string | null) => {
      checkedIdsRef.current.add(id)
      settleNativeChatDraftAttachment(attachmentScopeKey, settledChip(id, path, connectionId))
    },
    [attachmentScopeKey]
  )

  const removeImageAttachment = useCallback(
    (id: string) => removeNativeChatDraftAttachment(attachmentScopeKey, id),
    [attachmentScopeKey]
  )

  const imageAttachments = useMemo(
    () =>
      shared.map((chip): NativeChatComposerImageAttachment => {
        const previewUrl = previewsRef.current.get(chip.id)
        return {
          ...chip,
          ...(previewUrl ? { previewUrl } : {}),
          ...(missingIds.has(chip.id) ? { missing: true } : {}),
          ...(checkingIds.has(chip.id) ? { checking: true } : {})
        }
      }),
    [checkingIds, missingIds, shared]
  )

  return {
    imageAttachments,
    attachResolvedPaths,
    clearImageAttachments: () => clearNativeChatDraftAttachments(attachmentScopeKey),
    flushPendingAttachments,
    removeImageAttachment,
    beginPendingImageAttachment,
    resolvePendingImageAttachment,
    dropPendingImageAttachment: removeImageAttachment
  }
}

function settledChip(
  id: string,
  path: string,
  connectionId?: string | null,
  onRuntimeHost = false
): NativeChatDraftChip {
  if (connectionId) {
    return { id, path, connectionId, location: 'ssh' }
  }
  return { id, path, location: onRuntimeHost ? 'runtime' : 'local' }
}

/** Object URLs minted from a clipboard blob leak until revoked; data URLs don't. */
function releasePreviewUrl(previewUrl: string): void {
  if (previewUrl.startsWith('blob:')) {
    URL.revokeObjectURL(previewUrl)
  }
}
