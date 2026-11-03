import type * as React from 'react'
import {
  AttachmentTextSource,
  type AttachmentTextRead,
  type AttachmentTextWindow
} from './attachment-text-source'

type Preview = {
  source: AttachmentTextSource
  revision: number
  busy: boolean
  error: string
  readError: string
}

export function createAttachmentTextPreviewHook({
  useState,
  useEffect,
  useCallback
}: Pick<typeof React, 'useState' | 'useEffect' | 'useCallback'>) {
  return function useAttachmentTextPreview(path: string, read: AttachmentTextRead) {
    const [retryRevision, setRetryRevision] = useState(0)
    const [preview, setPreview] = useState<Preview>(() => ({
      source: new AttachmentTextSource(path, read),
      revision: 0,
      busy: false,
      error: '',
      readError: ''
    }))
    const demand = useCallback((source: AttachmentTextSource, window: AttachmentTextWindow) => {
      setPreview((state) => (state.source === source ? { ...state, readError: '' } : state))
      source.requestViewport(window, (cause) => {
        setPreview((state) =>
          state.source === source && !source.disposed
            ? {
                ...state,
                revision: state.revision + 1,
                readError:
                  cause === undefined
                    ? state.readError
                    : cause instanceof TypeError
                      ? 'This file cannot be previewed as text. Save it to open it in another app.'
                      : cause instanceof Error
                        ? cause.message
                        : 'Unable to open attachment. Try again.'
              }
            : state
        )
      })
    }, [])
    useEffect(() => {
      const source = new AttachmentTextSource(path, read)
      setPreview({ source, revision: 0, busy: false, error: '', readError: '' })
      demand(source, { block: 0, row: 0, rows: 1 })
      return () => source.dispose()
    }, [path, read, retryRevision, demand])
    return {
      ...preview,
      error: preview.error || preview.readError,
      setError: (error: string) =>
        setPreview((state) => (state.source === preview.source ? { ...state, error } : state)),
      setBusy: (busy: boolean) =>
        setPreview((state) => (state.source === preview.source ? { ...state, busy } : state)),
      demand: useCallback(
        (window: AttachmentTextWindow) => {
          if (!preview.readError) {
            demand(preview.source, window)
          }
        },
        [preview.source, preview.readError, demand]
      ),
      retry: () => setRetryRevision((value) => value + 1)
    }
  }
}
