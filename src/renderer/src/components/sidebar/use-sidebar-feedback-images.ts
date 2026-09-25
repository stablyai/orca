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
  /** Live committed+pending count and bytes, for the paste and attach gates. */
  getReservedImageCapacity: () => { count: number; bytes: number }
} {
  const [images, setImages] = useState<FeedbackImageDraft[]>([])
  const [pendingImageReadCount, setPendingImageReadCount] = useState(0)
  const liveImageDraftsRef = useRef<FeedbackImageDraft[]>([])
  // Why: committed state lags in-flight reads, so batches still being read count
  // against capacity — otherwise two quick pastes both see room for four.
  const pendingImageReadsRef = useRef({ count: 0, bytes: 0 })

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

  // Why: a read's callback moves its batch from pending to the live ref in one
  // step, but rendered state lags a render, so only the ref covers that gap.
  const getReservedImageCapacity = useCallback((): { count: number; bytes: number } => {
    const liveDrafts = liveImageDraftsRef.current
    const pendingReads = pendingImageReadsRef.current
    return {
      count: liveDrafts.length + pendingReads.count,
      bytes: liveDrafts.reduce((total, image) => total + image.bytes, 0) + pendingReads.bytes
    }
  }, [])

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
      const { count: existingCount, bytes: existingBytes } = getReservedImageCapacity()
      const pendingReads = pendingImageReadsRef.current
      const batchBytes = files.reduce((total, file) => total + file.size, 0)
      pendingReads.count += files.length
      pendingReads.bytes += batchBytes
      setPendingImageReadCount((current) => current + files.length)
      void readFeedbackImageFiles(files, existingCount, existingBytes).then(
        ({ images: added, errors }) => {
          pendingReads.count -= files.length
          pendingReads.bytes -= batchBytes
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
          pendingReads.count -= files.length
          pendingReads.bytes -= batchBytes
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
    [getReservedImageCapacity, params.isSubmitting, params.mountedRef]
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
    hasPendingImageReads: () => pendingImageReadsRef.current.count > 0,
    getReservedImageCapacity
  }
}
