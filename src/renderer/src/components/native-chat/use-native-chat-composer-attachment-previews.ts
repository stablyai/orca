import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

const NO_PREVIEWS: ReadonlyMap<string, string> = new Map()

/** Object URLs minted from a clipboard blob leak until revoked; data URLs don't. */
function releasePreviewUrl(previewUrl: string | undefined): void {
  if (previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(previewUrl)
  }
}

/** Composer-owned previews outlive neither their draft/pending chip nor their composer; no store holds their URLs. */
export function useNativeChatComposerAttachmentPreviews(
  settled: readonly NativeChatComposerImageAttachment[],
  pending: readonly NativeChatComposerImageAttachment[]
): {
  previews: ReadonlyMap<string, string>
  setPreview: (id: string, previewUrl: string | undefined) => void
  releasePreview: (id: string) => void
  releaseAllPreviews: () => void
} {
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(NO_PREVIEWS)
  // Read by callbacks between renders; only they change it, always together with the state.
  const previewsRef = useRef(previews)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      previewsRef.current.forEach(releasePreviewUrl)
      previewsRef.current = NO_PREVIEWS
    }
  }, [])
  const updatePreviews = useCallback((next: ReadonlyMap<string, string>) => {
    previewsRef.current = next
    setPreviews(next)
  }, [])
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
  }, [pending, settled, updatePreviews])

  const setPreview = useCallback(
    (id: string, previewUrl: string | undefined) => {
      if (!mountedRef.current) {
        releasePreviewUrl(previewUrl)
        return
      }
      if (previewUrl) {
        updatePreviews(new Map(previewsRef.current).set(id, previewUrl))
      }
    },
    [updatePreviews]
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
    [updatePreviews]
  )

  const releaseAllPreviews = useCallback(() => {
    previewsRef.current.forEach(releasePreviewUrl)
    updatePreviews(NO_PREVIEWS)
  }, [updatePreviews])

  return { previews, setPreview, releasePreview, releaseAllPreviews }
}
