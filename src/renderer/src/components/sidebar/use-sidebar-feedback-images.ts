import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  readFeedbackImageFiles,
  releaseFeedbackImageDraft,
  type FeedbackImageDraft
} from '@/lib/feedback-image-attachments'
import { useFeedbackImageDrop } from './use-feedback-image-drop'

export function useSidebarFeedbackImages(params: {
  open: boolean
  isSubmitting: boolean
  mountedRef: RefObject<boolean>
}): {
  images: FeedbackImageDraft[]
  pendingImageReadCount: number
  isDragActive: boolean
  contentRef: ReturnType<typeof useFeedbackImageDrop>['contentRef']
  dragHandlers: ReturnType<typeof useFeedbackImageDrop>['dragHandlers']
  handleAddFiles: (files: readonly File[]) => void
  handleRemoveImage: (id: string) => void
  clearImages: () => void
  hasPendingImageReads: () => boolean
  /** Live committed+pending count for paste capacity checks. */
  getReservedImageSlots: () => number
} {
  const [images, setImages] = useState<FeedbackImageDraft[]>([])
  const [pendingImageReadCount, setPendingImageReadCount] = useState(0)
  const liveImageDraftsRef = useRef<FeedbackImageDraft[]>([])
  // Why: committed state lags in-flight reads, so batches still being read count
  // against capacity — otherwise two quick pastes both see room for four.
  const pendingImageReadsRef = useRef(0)
  const imageCount = images.length

  const clearImages = useCallback(() => {
    liveImageDraftsRef.current.forEach(releaseFeedbackImageDraft)
    liveImageDraftsRef.current = []
    setImages([])
  }, [])

  // Why: object URLs for the thumbnails leak until revoked.
  useEffect(
    () => () => {
      liveImageDraftsRef.current.forEach(releaseFeedbackImageDraft)
      liveImageDraftsRef.current = []
    },
    []
  )

  const handleAddFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) {
        return
      }
      if (params.isSubmitting) {
        toast.warning(
          translate(
            'auto.components.sidebar.SidebarFeedbackDialog.attachWhileSending',
            'Wait for the current feedback to finish sending before attaching more images.'
          )
        )
        return
      }
      // Why: read the committed count from the closure rather than a ref. A ref
      // synced in an effect can still be stale-low right after an add.
      const existingCount = imageCount + pendingImageReadsRef.current
      pendingImageReadsRef.current += files.length
      setPendingImageReadCount((current) => current + files.length)
      void readFeedbackImageFiles(files, existingCount).then(
        ({ images: added, errors }) => {
          pendingImageReadsRef.current -= files.length
          if (!params.mountedRef.current) {
            added.forEach(releaseFeedbackImageDraft)
            return
          }
          setPendingImageReadCount((current) => Math.max(0, current - files.length))
          if (added.length > 0) {
            liveImageDraftsRef.current = [...liveImageDraftsRef.current, ...added]
            setImages((existing) => [...existing, ...added])
          }
          // Why: never drop an attachment without telling the user.
          errors.forEach((error) => toast.warning(error))
        },
        (error: unknown) => {
          pendingImageReadsRef.current -= files.length
          console.error('Failed to read feedback image attachments:', error)
          if (params.mountedRef.current) {
            setPendingImageReadCount((current) => Math.max(0, current - files.length))
            toast.error(
              translate(
                'auto.components.sidebar.SidebarFeedbackDialog.imageReadFailed',
                'Could not read the attached images. Try attaching them again.'
              )
            )
          }
        }
      )
    },
    [imageCount, params.isSubmitting, params.mountedRef]
  )

  const handleRemoveImage = useCallback((id: string) => {
    const removed = liveImageDraftsRef.current.find((image) => image.id === id)
    if (removed) {
      releaseFeedbackImageDraft(removed)
      liveImageDraftsRef.current = liveImageDraftsRef.current.filter((image) => image.id !== id)
    }
    setImages((current) => current.filter((image) => image.id !== id))
  }, [])

  const { isDragActive, contentRef, dragHandlers } = useFeedbackImageDrop(
    params.open,
    handleAddFiles
  )

  return {
    images,
    pendingImageReadCount,
    isDragActive,
    contentRef,
    dragHandlers,
    handleAddFiles,
    handleRemoveImage,
    clearImages,
    hasPendingImageReads: () => pendingImageReadsRef.current > 0,
    getReservedImageSlots: () => liveImageDraftsRef.current.length + pendingImageReadsRef.current
  }
}
