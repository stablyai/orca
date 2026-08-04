import { useCallback, useEffect, useRef, useState } from 'react'

import type { BrowserJavaScriptDialogOpenedEvent } from '../../../../shared/browser-javascript-dialog'

export function useBrowserJavaScriptDialog(browserPageId: string): {
  dialog: BrowserJavaScriptDialogOpenedEvent | null
  responding: boolean
  respond: (accept: boolean, promptText?: string) => Promise<boolean>
} {
  const [dialog, setDialog] = useState<BrowserJavaScriptDialogOpenedEvent | null>(null)
  const [respondingDialogId, setRespondingDialogId] = useState<string | null>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog

  useEffect(() => {
    let disposed = false
    let eventRevision = 0
    setDialog(null)
    setRespondingDialogId(null)

    const unsubscribeOpened = window.api.browser.onJavaScriptDialogOpened((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      eventRevision += 1
      setDialog(event)
    })
    const unsubscribeClosed = window.api.browser.onJavaScriptDialogClosed((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      eventRevision += 1
      setDialog((current) => (current?.dialogId === event.dialogId ? null : current))
      setRespondingDialogId((current) => (current === event.dialogId ? null : current))
    })

    const queryRevision = eventRevision
    void window.api.browser
      .getJavaScriptDialog({ browserPageId })
      .then((pending) => {
        if (!disposed && eventRevision === queryRevision) {
          setDialog(pending)
        }
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribeOpened()
      unsubscribeClosed()
    }
  }, [browserPageId])

  const respond = useCallback(
    async (accept: boolean, promptText?: string): Promise<boolean> => {
      const current = dialogRef.current
      if (!current) {
        return false
      }
      setRespondingDialogId(current.dialogId)
      try {
        const handled = await window.api.browser.respondJavaScriptDialog({
          browserPageId,
          dialogId: current.dialogId,
          accept,
          promptText
        })
        if (handled) {
          setDialog((latest) => (latest?.dialogId === current.dialogId ? null : latest))
        }
        return handled
      } catch {
        return false
      } finally {
        setRespondingDialogId((latest) => (latest === current.dialogId ? null : latest))
      }
    },
    [browserPageId]
  )

  return {
    dialog,
    responding: dialog !== null && respondingDialogId === dialog.dialogId,
    respond
  }
}
