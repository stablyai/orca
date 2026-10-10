import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { NativeChatImageAttachmentPreview } from '../native-chat/NativeChatImageAttachmentPreview'
import {
  TERMINAL_IMAGE_ATTACHMENT_EVENT,
  type TerminalImageAttachmentRequest
} from './terminal-image-attachment-request'

export function TerminalImageAttachmentTray({ container }: { container: HTMLElement }) {
  const [requests, setRequests] = useState<TerminalImageAttachmentRequest[]>([])
  const requestsRef = useRef<TerminalImageAttachmentRequest[]>([])
  const updateRequests = useCallback((next: TerminalImageAttachmentRequest[]) => {
    requestsRef.current = next
    setRequests(next)
  }, [])
  const cancelAll = () => {
    requestsRef.current.forEach((request) => request.cancel())
    updateRequests([])
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    const receive = (event: Event) => {
      if (
        !(event instanceof CustomEvent) ||
        !event.detail.isCurrent() ||
        requestsRef.current.length >= 4
      ) {
        return
      }
      const request: TerminalImageAttachmentRequest = event.detail
      event.preventDefault()
      updateRequests([...requestsRef.current, request])
      setError(false)
    }
    container.addEventListener(TERMINAL_IMAGE_ATTACHMENT_EVENT, receive)
    return () => {
      container.removeEventListener(TERMINAL_IMAGE_ATTACHMENT_EVENT, receive)
      requestsRef.current.forEach((request) => request.cancel())
      requestsRef.current = []
    }
  }, [container, updateRequests])

  if (requests.length === 0) {
    return null
  }
  const attach = async () => {
    setBusy(true)
    setError(false)
    for (const request of requests) {
      try {
        if (!request.isCurrent() || !(await request.attach())) {
          setError(true)
          setBusy(false)
          return
        }
        updateRequests(requestsRef.current.filter((item) => item !== request))
      } catch {
        setError(true)
        setBusy(false)
        return
      }
    }
    setBusy(false)
  }
  return (
    <div
      data-terminal-image-attachments
      className="scrollbar-sleek absolute inset-x-2 top-10 z-20 max-h-[calc(100%-3rem)] max-w-sm overflow-y-auto rounded-lg border border-border bg-background p-3 text-foreground shadow-xs"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <p className="mb-2 text-xs text-muted-foreground">
        {translate(
          'terminal.imageAttachments.codexPreview',
          'Codex image preview · Not yet attached'
        )}
      </p>
      <div className="mb-3 flex flex-wrap gap-2" aria-busy={busy}>
        {requests.map(({ attachment, fullSizePreviewUrl }) => (
          <NativeChatImageAttachmentPreview
            key={attachment.id}
            attachment={attachment}
            fullSizePreviewUrl={fullSizePreviewUrl}
            removeDisabled={busy}
            onRemove={(id) => {
              if (busy) {
                return
              }
              requestsRef.current.find((item) => item.attachment.id === id)?.cancel()
              updateRequests(requestsRef.current.filter((item) => item.attachment.id !== id))
            }}
          />
        ))}
      </div>
      {error && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {translate(
            'terminal.imageAttachments.failed',
            'Could not attach image. Check the session and try again.'
          )}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="h-auto min-h-8 max-w-full whitespace-normal"
          disabled={busy}
          onClick={() => void attach()}
        >
          {translate('terminal.imageAttachments.attach', 'Add to Codex')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-auto min-h-8 max-w-full whitespace-normal"
          disabled={busy}
          onClick={cancelAll}
        >
          {translate('terminal.imageAttachments.cancel', 'Cancel')}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {translate(
          'terminal.imageAttachments.noSubmit',
          'Add images, then send from Codex. Other CLIs use their existing paste flow.'
        )}
      </p>
    </div>
  )
}
