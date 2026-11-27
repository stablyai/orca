import { Suspense, useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import {
  subscribeNewFileExtensionPicker,
  type NewFileExtensionPickerRequest,
  type NewFileExtensionSelection
} from '@/lib/editor/file-operations/new-file-extension-picker-request'

const NewFileExtensionPickerDialog = lazy(() =>
  import('./NewFileExtensionPickerDialog').then((module) => ({
    default: module.NewFileExtensionPickerDialog
  }))
)

export function NewFileExtensionPicker(): JSX.Element | null {
  const [activeRequest, setActiveRequest] = useState<NewFileExtensionPickerRequest | null>(null)
  const [hasOpened, setHasOpened] = useState(false)
  const activeRequestRef = useRef<NewFileExtensionPickerRequest | null>(null)
  activeRequestRef.current = activeRequest

  const resolveRequest = useCallback((selection: NewFileExtensionSelection): void => {
    const request = activeRequestRef.current
    if (!request) {
      return
    }

    activeRequestRef.current = null
    request.resolve(selection)
    setActiveRequest(null)
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeNewFileExtensionPicker((request) => {
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
      <NewFileExtensionPickerDialog activeRequest={activeRequest} resolveRequest={resolveRequest} />
    </Suspense>
  )
}
