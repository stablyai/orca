import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { addLargeTextControlPasteListener } from '@/lib/large-text-control-paste'

export function useLargeTextControlPaste(): void {
  useEffect(
    () =>
      addLargeTextControlPasteListener(document, {
        onPasteResult: (result) => {
          if (result.status === 'rejected' && result.reason === 'too-large') {
            toast.error(
              translate('auto.hooks.useLargeTextControlPaste.pasteTooLarge', 'Paste is too large.')
            )
          }
        }
      }),
    []
  )
}
