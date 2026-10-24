import {
  createNativeChatReturnField,
  NativeChatViewIdentity,
  nativeChatViewRetirements,
  useNativeChatReturnRef,
  useNativeChatReturnState
} from './native-chat-view-state-memory'
import { useCallback, useEffect, useContext } from 'react'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

const previewRecords = new Map<string, ReadonlyMap<string, string>>()
nativeChatViewRetirements.add((key) => {
  previewRecords.get(key)?.forEach(releasePreviewUrl)
  previewRecords.delete(key)
})
const previewField = createNativeChatReturnField<ReadonlyMap<string, string>>()
const NO_PREVIEWS: ReadonlyMap<string, string> = new Map()

/** Object URLs minted from a clipboard blob leak until revoked; data URLs don't. */
function releasePreviewUrl(previewUrl: string | undefined): void {
  if (previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(previewUrl)
  }
}

/** The clipboard previews a composer minted, by chip id: its own, since no store holds them. A
 *  preview whose chip left both the draft and the pending chips (sent, or removed elsewhere) is
 *  released. */
export function useNativeChatComposerAttachmentPreviews(
  settled: readonly NativeChatComposerImageAttachment[],
  pending: readonly NativeChatComposerImageAttachment[]
): {
  previews: ReadonlyMap<string, string>
  setPreview: (id: string, previewUrl: string | undefined) => void
  releasePreview: (id: string) => void
  releaseAllPreviews: () => void
} {
  const [previews, setPreviews] = useNativeChatReturnState(previewField, () => NO_PREVIEWS)
  // Read by callbacks between renders; only they change it, always together with the state.
  const previewsRef = useNativeChatReturnRef(previewField, () => NO_PREVIEWS)
  const identity = useContext(NativeChatViewIdentity)
  useEffect(() => {
    if (identity === null) {
      previewsRef.retired = false
    }
    return () => {
      if (identity === null) {
        previewsRef.retired = true
        previewsRef.current.forEach(releasePreviewUrl)
        previewsRef.current = NO_PREVIEWS
      }
    }
  }, [identity, previewsRef])
  const updatePreviews = useCallback(
    (next: ReadonlyMap<string, string>) => {
      if (previewsRef.retired) {
        next.forEach(releasePreviewUrl)
        return
      }
      previewsRef.current = next
      if (identity !== null) {
        previewRecords.set(identity, next)
      }
      setPreviews(next)
    },
    [identity, previewsRef, setPreviews]
  )
  useEffect(() => {
    const current = previewsRef.current
    const gone = [...current.keys()].filter(
      (id) => !settled.some((image) => image.id === id) && !pending.some((chip) => chip.id === id)
    )
    if (gone.length === 0) {
      return
    }
    const next = new Map(current)
    for (const id of gone) {
      releasePreviewUrl(next.get(id))
      next.delete(id)
    }
    updatePreviews(next)
  }, [pending, previewsRef, settled, updatePreviews])

  const setPreview = useCallback(
    (id: string, previewUrl: string | undefined) => {
      if (previewUrl) {
        updatePreviews(new Map(previewsRef.current).set(id, previewUrl))
      }
    },
    [previewsRef, updatePreviews]
  )

  const releasePreview = useCallback(
    (id: string) => {
      const current = previewsRef.current
      if (!current.has(id)) {
        return
      }
      releasePreviewUrl(current.get(id))
      const next = new Map(current)
      next.delete(id)
      updatePreviews(next)
    },
    [previewsRef, updatePreviews]
  )

  const releaseAllPreviews = useCallback(() => {
    previewsRef.current.forEach(releasePreviewUrl)
    updatePreviews(NO_PREVIEWS)
  }, [previewsRef, updatePreviews])

  return { previews, setPreview, releasePreview, releaseAllPreviews }
}
