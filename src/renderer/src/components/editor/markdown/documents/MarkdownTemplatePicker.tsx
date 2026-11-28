import { Suspense, useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import type {
  MarkdownTemplatePickerRequest,
  MarkdownTemplateSelection
} from '@/lib/editor/markdown/documents/markdown-template-picker-request'
import { subscribeMarkdownTemplatePicker } from '@/lib/editor/markdown/documents/markdown-template-picker-request'

const MarkdownTemplatePickerDialog = lazy(() =>
  import('./MarkdownTemplatePickerDialog').then((module) => ({
    default: module.MarkdownTemplatePickerDialog
  }))
)

export function MarkdownTemplatePicker(): JSX.Element | null {
  const [activeRequest, setActiveRequest] = useState<MarkdownTemplatePickerRequest | null>(null)
  const [hasOpened, setHasOpened] = useState(false)
  const activeRequestRef = useRef<MarkdownTemplatePickerRequest | null>(null)
  activeRequestRef.current = activeRequest

  const resolveRequest = useCallback((selection: MarkdownTemplateSelection): void => {
    const request = activeRequestRef.current
    if (!request) {
      return
    }

    activeRequestRef.current = null
    request.resolve(selection)
    setActiveRequest(null)
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeMarkdownTemplatePicker((request) => {
      activeRequestRef.current?.resolve({ type: 'cancel' })
      activeRequestRef.current = request
      setHasOpened(true)
      setActiveRequest(request)
    })

    return () => {
      activeRequestRef.current?.resolve({ type: 'cancel' })
      activeRequestRef.current = null
      unsubscribe()
    }
  }, [])

  if (!activeRequest && !hasOpened) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <MarkdownTemplatePickerDialog activeRequest={activeRequest} resolveRequest={resolveRequest} />
    </Suspense>
  )
}
