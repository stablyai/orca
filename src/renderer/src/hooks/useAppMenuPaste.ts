import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { handleAppMenuPasteRequest } from '@/lib/app-menu-paste'

export function useAppMenuPaste(): void {
  useEffect(() => {
    const handlePaste = (options?: { mode?: 'paste' | 'paste-and-match-style' }): void => {
      void handleAppMenuPasteRequest({
        readClipboardText: window.api.ui.readClipboardText,
        performNativePaste: window.api.ui.performNativePaste,
        nativePasteMode: options?.mode ?? 'paste'
      })
        .then((result) => {
          if (result.status === 'rejected' && result.reason === 'too-large') {
            toast.error(
              translate('auto.hooks.useAppMenuPaste.pasteTooLarge', 'Paste is too large.')
            )
          }
        })
        .catch(() => {
          // Why: only the request handler knows whether native fallback is
          // still targeting the originally owned control after async work.
          return undefined
        })
    }

    const unsubscribeAppMenuPaste = window.api.ui.onAppMenuPaste(() => handlePaste())
    const unsubscribeEditableContextPaste = window.api.ui.onEditableContextPaste((data) => {
      handlePaste({ mode: data.plainTextOnly ? 'paste-and-match-style' : 'paste' })
    })
    return () => {
      unsubscribeAppMenuPaste()
      unsubscribeEditableContextPaste()
    }
  }, [])
}
