import { useEffect } from 'react'
import { handleAppMenuPasteRequest } from '@/lib/app-menu-paste'

export function useAppMenuPaste(): void {
  useEffect(
    () =>
      window.api.ui.onEditableContextPaste(({ plainTextOnly }) => {
        handleAppMenuPasteRequest({
          performNativePaste: window.api.ui.performNativePaste,
          nativePasteMode: plainTextOnly ? 'paste-and-match-style' : 'paste'
        })
      }),
    []
  )
}
