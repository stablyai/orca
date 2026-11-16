import { useOsFileDropOwner } from '@/hooks/use-os-file-drop-owner'
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { captureGitHubImageUpload, type GitHubImageUploadAddress } from './github-image-upload'

export type GitHubImageIntake = {
  address?: GitHubImageUploadAddress | (() => GitHubImageUploadAddress)
  onPending?: (pending: boolean) => void
  enabled?: boolean
}

export function useGitHubImageUploads(options: GitHubImageIntake) {
  const t = useTranslate()
  const latest = useRef(options)
  const pending = useRef(0)
  const tail = useRef(Promise.resolve())
  const lifetime = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    latest.current = options
  })
  useLayoutEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => {
      controller.abort()
      latest.current.onPending?.(false)
    }
  }, [])

  const receive = (files: File[], insert: (file: File) => (url?: string) => void): boolean => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) {
      return false
    }
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (!images.length || latest.current.enabled === false) {
      return false
    }
    try {
      const address = latest.current.address
      if (!address) {
        throw new Error('Open this GitHub repository before attaching an image.')
      }
      const upload = captureGitHubImageUpload(typeof address === 'function' ? address() : address)
      for (const file of images) {
        const replace = insert(file)
        pending.current++
        latest.current.onPending?.(true)
        tail.current = tail.current
          .then(async () => {
            try {
              if (signal.aborted) {
                return
              }
              const url = await upload(file, signal)
              if (!signal.aborted) {
                replace(url)
              }
            } catch (error) {
              if (!signal.aborted) {
                replace()
                toast.error(
                  t('github.imageUploadFailed', 'Could not attach image: {{message}}', {
                    message:
                      error instanceof Error ? error.message : 'Paste the image again to retry.'
                  })
                )
              }
            } finally {
              pending.current--
              if (!signal.aborted) {
                latest.current.onPending?.(pending.current > 0)
              }
            }
          })
          .catch(() => {})
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t('github.imageUploadError', 'GitHub could not upload this image.')
      )
    }
    return true
  }
  return { receive, pending }
}

export function useGitHubImagePending() {
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const onPending = useCallback((value: boolean) => {
    pendingRef.current = value
    setPending(value)
  }, [])
  return { pending, pendingRef, onPending }
}

export function useGitHubImageEvents<Destination>(
  root: RefObject<HTMLElement | null>,
  receive: (files: File[], destination?: Destination) => boolean,
  captureDestination: (event: DragEvent) => Destination,
  canAccept: (event: DragEvent) => boolean
) {
  const latest = useRef(receive)
  useLayoutEffect(() => {
    latest.current = receive
  })
  const attachDrop = useOsFileDropOwner(root, {
    kind: 'files',
    captureDestination,
    canAccept,
    onFiles: (files, { destination }) => {
      latest.current(files, destination)
    }
  })
  return {
    attachDrop,
    paste: (event: ClipboardEvent | React.ClipboardEvent<HTMLTextAreaElement>) =>
      latest.current(Array.from(event.clipboardData?.files ?? []))
  }
}
