import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'

type PasteToDirectory = (directory?: string | null) => void

export function useFileExplorerKeyboardPasteConfirmation(pasteToDirectory: PasteToDirectory): {
  open: boolean
  request: (directory: string) => void
  cancel: () => void
  confirm: (dontAskAgain: boolean) => void
} {
  const t = useTranslate()
  const pendingDirectoryRef = useRef<string | null>(null)
  const [open, setOpen] = useState(false)

  const cancel = useCallback((): void => {
    pendingDirectoryRef.current = null
    setOpen(false)
  }, [])

  const request = useCallback(
    (directory: string): void => {
      if (
        useAppStore.getState().settings?.fileExplorerKeyboardPasteConfirmationDismissed === true
      ) {
        pasteToDirectory(directory)
        return
      }
      pendingDirectoryRef.current = directory
      setOpen(true)
    },
    [pasteToDirectory]
  )

  const confirm = useCallback(
    (dontAskAgain: boolean): void => {
      const directory = pendingDirectoryRef.current
      cancel()
      if (!directory) {
        return
      }
      if (dontAskAgain) {
        void useAppStore
          .getState()
          .updateSettings({ fileExplorerKeyboardPasteConfirmationDismissed: true })
          .catch(() => {
            toast.error(
              t(
                'auto.components.right.sidebar.FileExplorerKeyboardPaste.preferenceSaveFailed',
                'Could not save the confirmation preference.'
              )
            )
          })
      }
      pasteToDirectory(directory)
    },
    [cancel, pasteToDirectory, t]
  )

  return { open, request, cancel, confirm }
}
