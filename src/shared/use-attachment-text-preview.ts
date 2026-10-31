import type * as React from 'react'
import { AttachmentTextSource, type AttachmentTextRead } from './attachment-text-source'

type Display = Awaited<ReturnType<AttachmentTextSource['page']>>
type Preview = {
  source: AttachmentTextSource
  display: Display | null
  busy: boolean
  error: string
}

export function createAttachmentTextPreviewHook({
  useState,
  useEffect,
  useCallback
}: Pick<typeof React, 'useState' | 'useEffect' | 'useCallback'>) {
  return function useAttachmentTextPreview(path: string, read: AttachmentTextRead) {
    const [revision, setRevision] = useState(0)
    const [preview, setPreview] = useState<Preview>(() => ({
      source: new AttachmentTextSource(path, read),
      display: null,
      busy: true,
      error: ''
    }))
    const loadSource = useCallback(
      async (source: AttachmentTextSource, page: number, subpage = 0) => {
        setPreview((state) =>
          state.source === source ? { ...state, busy: true, error: '' } : state
        )
        try {
          const display = await source.page(page, subpage)
          source.assertCurrent()
          setPreview((state) => (state.source === source ? { ...state, display } : state))
        } catch (cause) {
          if (!source.disposed) {
            setPreview((state) =>
              state.source === source
                ? {
                    ...state,
                    error:
                      cause instanceof TypeError
                        ? 'This file cannot be previewed as text. Save it to open it in another app.'
                        : cause instanceof Error
                          ? cause.message
                          : 'Unable to open attachment. Try again.'
                  }
                : state
            )
          }
        } finally {
          if (!source.disposed) {
            setPreview((state) => (state.source === source ? { ...state, busy: false } : state))
          }
        }
      },
      []
    )
    useEffect(() => {
      const source = new AttachmentTextSource(path, read)
      setPreview({ source, display: null, busy: true, error: '' })
      void loadSource(source, 0)
      return () => source.dispose()
    }, [path, read, revision, loadSource])
    return {
      ...preview,
      setError: (error: string) =>
        setPreview((state) => (state.source === preview.source ? { ...state, error } : state)),
      setBusy: (busy: boolean) =>
        setPreview((state) => (state.source === preview.source ? { ...state, busy } : state)),
      load: (page: number, subpage = 0) => loadSource(preview.source, page, subpage),
      retry: () => setRevision((value) => value + 1)
    }
  }
}
