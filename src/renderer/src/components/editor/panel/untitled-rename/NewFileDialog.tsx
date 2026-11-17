import { useEffect, useRef, useState, type JSX } from 'react'
import {
  subscribeNewFileRequests,
  type NewFileRequest
} from '@/lib/editor/file-operations/new-file-request'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { useTranslate } from '@/i18n/use-translate'
import { UntitledFileRenameDialog } from './UntitledFileRenameDialog'

// Why module-level: React Compiler cannot compile a try/finally inside a component.
async function attemptCreate(
  request: NewFileRequest,
  relativePath: string
): Promise<{ error: unknown } | null> {
  try {
    await request.create(relativePath)
    return null
  } catch (error) {
    return { error }
  }
}

export function NewFileDialog(): JSX.Element | null {
  const t = useTranslate()
  const [request, setRequest] = useState<NewFileRequest | null>(null)
  const activeRequestRef = useRef<NewFileRequest | null>(null)
  const creatingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [showPendingIndicator, setShowPendingIndicator] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = subscribeNewFileRequests((nextRequest) => {
      activeRequestRef.current?.resolve(null)
      activeRequestRef.current = nextRequest
      creatingRef.current = false
      setPending(false)
      setShowPendingIndicator(false)
      setError(null)
      setRequest(nextRequest)
    })
    return () => {
      activeRequestRef.current?.resolve(null)
      activeRequestRef.current = null
      unsubscribe()
    }
  }, [])

  if (!request) {
    return null
  }

  const finish = (relativePath: string | null): void => {
    if (activeRequestRef.current !== request) {
      return
    }
    activeRequestRef.current = null
    request.resolve(relativePath)
    setRequest(null)
  }
  const create = async (relativePath: string): Promise<void> => {
    if (creatingRef.current || activeRequestRef.current !== request) {
      return
    }
    creatingRef.current = true
    setPending(true)
    setError(null)
    const indicatorTimer = window.setTimeout(() => {
      if (activeRequestRef.current === request) {
        setShowPendingIndicator(true)
      }
    }, 200)
    const failure = await attemptCreate(request, relativePath)
    window.clearTimeout(indicatorTimer)
    if (activeRequestRef.current !== request) {
      return
    }
    creatingRef.current = false
    setPending(false)
    setShowPendingIndicator(false)
    if (!failure) {
      finish(relativePath)
      return
    }
    const message = extractIpcErrorMessage(
      failure.error,
      t('auto.components.editor.NewFileDialog.failed', "Couldn't create the file.")
    )
    setError(
      /EEXIST|already exists/i.test(message)
        ? t(
            'auto.components.editor.UntitledFileRenameDialog.nameTaken',
            'A file with that name already exists'
          )
        : message
    )
  }

  return (
    <UntitledFileRenameDialog
      key={request.id}
      open
      currentName=""
      worktreePath={request.worktreePath}
      initialDirectory={request.initialDirectory}
      disableBrowse={request.disableBrowse}
      preserveExtension={false}
      title={t('auto.components.editor.NewFileDialog.title', 'New File')}
      description={t(
        'auto.components.editor.NewFileDialog.description',
        'Enter a file name including its extension and pick a folder.'
      )}
      confirmLabel={t('auto.components.editor.NewFileDialog.create', 'Create')}
      pending={pending}
      showPendingIndicator={showPendingIndicator}
      externalError={error}
      onInputChange={() => setError(null)}
      onClose={() => {
        if (!creatingRef.current) {
          finish(null)
        }
      }}
      onConfirm={(relativePath) => void create(relativePath)}
    />
  )
}
