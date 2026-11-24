import { useEffect, useRef, useState } from 'react'
import { MarkdownPreviewDocumentClient } from './markdown-preview-document-client'
import type { MarkdownPreviewDocument } from './markdown-preview-document-types'

type ReadyDocumentState = {
  content: string
  status: 'ready'
  revision: number
  document: MarkdownPreviewDocument
  client: MarkdownPreviewDocumentClient
}
type DocumentState =
  | { content: string; status: 'loading' }
  | { content: string; status: 'error'; message: string }
  | ReadyDocumentState

export function useMarkdownPreviewDocument(
  content: string,
  enabled: boolean,
  beforeSwap?: () => void
) {
  const [state, setState] = useState<DocumentState>({ content, status: 'loading' })
  const [refreshFailure, setRefreshFailure] = useState<{ content: string; message: string } | null>(
    null
  )
  const [previousEnabled, setPreviousEnabled] = useState(enabled)
  if (previousEnabled !== enabled) {
    setPreviousEnabled(enabled)
    setState({ content, status: 'loading' })
    setRefreshFailure(null)
  }
  const displayed = useRef<ReadyDocumentState | null>(null)
  const revision = useRef(0)

  useEffect(
    () => () => {
      displayed.current?.client.close()
      displayed.current = null
    },
    []
  )

  useEffect(() => {
    let active = true
    let client: MarkdownPreviewDocumentClient | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      active = false
      if (timer !== null) {
        clearTimeout(timer)
      }
      if (client !== displayed.current?.client) {
        client?.close()
      }
    }
    if (!enabled) {
      displayed.current?.client.close()
      displayed.current = null
      return cleanup
    }
    if (displayed.current?.content === content) {
      return cleanup
    }
    const fail = (error: Error): void => {
      if (!active && displayed.current?.client !== client) {
        return
      }
      if (displayed.current && displayed.current.client !== client) {
        setRefreshFailure({ content, message: error.message })
      } else {
        displayed.current = null
        setState({ content, status: 'error', message: error.message })
      }
    }
    const load = (): void => {
      try {
        client = new MarkdownPreviewDocumentClient(
          new Worker(new URL('./markdown-preview-document.worker.ts', import.meta.url), {
            type: 'module'
          }),
          fail
        )
      } catch {
        fail(new Error('Unable to start preview worker.'))
        return
      }
      const loadingClient = client
      void loadingClient
        .request({ type: 'load', content })
        .then((result) => {
          if (active && result.type === 'loaded') {
            const previous = displayed.current
            const ready: ReadyDocumentState = {
              content,
              status: 'ready',
              revision: ++revision.current,
              document: result.document,
              client: loadingClient
            }
            beforeSwap?.()
            displayed.current = ready
            setState(ready)
            setRefreshFailure(null)
            previous?.client.close()
          }
        })
        .catch((error) => {
          if (error instanceof Error) {
            fail(error)
          }
        })
    }
    if (displayed.current) {
      timer = setTimeout(load, 150)
    } else {
      load()
    }
    return cleanup
  }, [content, enabled, beforeSwap])

  const visibleState =
    enabled &&
    previousEnabled === enabled &&
    (state.status === 'ready' || state.content === content)
      ? state
      : { content, status: 'loading' as const }
  return {
    ...visibleState,
    refreshing: enabled && visibleState.status === 'ready' && visibleState.content !== content,
    refreshError: refreshFailure?.content === content ? refreshFailure.message : null
  }
}
