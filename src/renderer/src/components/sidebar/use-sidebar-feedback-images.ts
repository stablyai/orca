import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  maxFeedbackImageBatchBytes,
  readFeedbackImageFiles,
  releaseFeedbackImageDraft,
  type FeedbackImageDraft
} from '@/lib/feedback-image-attachments'
import { useFeedbackImageDrop } from './use-feedback-image-drop'

function sumImageBytes(images: readonly FeedbackImageDraft[]): number {
  return images.reduce((total, image) => total + image.bytes, 0)
}

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
  /** Live committed+pending count and bytes, for the synchronous paste gate. */
  getReservedImageCapacity: () => { count: number; bytes: number }
} {
  const [images, setImages] = useState<FeedbackImageDraft[]>([])
  const [pendingImageReadCount, setPendingImageReadCount] = useState(0)
  const liveImageDraftsRef = useRef<FeedbackImageDraft[]>([])
  // Reserve queued reads synchronously so rapid pastes cannot each claim the same free capacity.
  const pendingImageReadsRef = useRef({ count: 0, bytes: 0 })
  // Read batches serially because compression sizes are unknown until earlier batches commit.
  const readQueueRef = useRef<Promise<void> | null>(null)

  const clearImages = useCallback(() => {
    liveImageDraftsRef.current.forEach(releaseFeedbackImageDraft)
    liveImageDraftsRef.current = []
    setImages([])
  }, [])

  useEffect(
    () => () => {
      liveImageDraftsRef.current.forEach(releaseFeedbackImageDraft)
      liveImageDraftsRef.current = []
    },
    []
  )

  // Rendered state lags read completion; the live ref closes that reservation-count gap.
  const getReservedImageCapacity = useCallback((): { count: number; bytes: number } => {
    const liveDrafts = liveImageDraftsRef.current
    const pendingReads = pendingImageReadsRef.current
    return {
      count: liveDrafts.length + pendingReads.count,
      bytes: sumImageBytes(liveDrafts) + pendingReads.bytes
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
      const pendingReads = pendingImageReadsRef.current
      // Why: earlier reads can fail and attached images can be removed before this reads.
      const batchBytes = maxFeedbackImageBatchBytes(files, 0, 0)
      pendingReads.count += files.length
      pendingReads.bytes += batchBytes
      setPendingImageReadCount((current) => current + files.length)
      const read = (readQueueRef.current ?? Promise.resolve()).then(() => {
        // Why: an unmounted dialog discards whatever this reads, so skip the decode and re-encodes.
        if (!params.mountedRef.current) {
          return { images: [], errors: [], notices: [] }
        }
        const committed = liveImageDraftsRef.current
        return readFeedbackImageFiles(files, committed.length, sumImageBytes(committed))
      })
      const settled = read.then(
        ({ images: added, errors, notices }) => {
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
          // Why: never drop or degrade an attachment without telling the user.
          notices.forEach((notice) => toast.info(notice))
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
      // Recover the queue tail after callback errors so later attachments are not poisoned by a rejected promise.
      readQueueRef.current = settled.catch((error: unknown) => {
        console.error('Failed to settle a feedback image batch:', error)
      })
    },
    [params.isSubmitting, params.mountedRef]
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
