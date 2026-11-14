import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { basename } from '@/lib/path'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import type { RuntimeFileReadArgs } from '@/runtime/files/runtime-file-client-types'
import {
  isClientLocalRuntimeFile,
  openRuntimeFileWithDefaultApp
} from '@/runtime/files/reads/runtime-file-default-app-open'

async function openWithDefaultApp(
  source: RuntimeFileReadArgs
): Promise<{ opened: boolean } | { opened: false; error: unknown }> {
  try {
    return { opened: await openRuntimeFileWithDefaultApp(source) }
  } catch (error) {
    return { opened: false, error }
  }
}

/** The way out of the "cannot display" tab: hand the file to the app this OS registers for it. */
export function BinaryFileDefaultAppButton({
  source
}: {
  source: RuntimeFileReadArgs
}): React.JSX.Element | null {
  const t = useTranslate()
  const [pending, setPending] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  // Why: a paired web client has no OS app to hand the file to.
  if (isPairedWebClientWindow()) {
    return null
  }
  const local = isClientLocalRuntimeFile(source)
  const open = async (): Promise<void> => {
    setPending(true)
    setOpenFailed(false)
    const outcome = await openWithDefaultApp(source)
    setPending(false)
    if ('error' in outcome && !local) {
      toast.error(
        extractIpcErrorMessage(
          outcome.error,
          t(
            'auto.components.editor.BinaryFileDefaultAppButton.downloadFailed',
            "Failed to download '{{value0}}'.",
            { value0: basename(source.filePath) }
          )
        )
      )
      return
    }
    setOpenFailed(!outcome.opened)
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <Button variant="outline" size="sm" disabled={pending} onClick={() => void open()}>
        {local
          ? t('auto.components.editor.BinaryFileDefaultAppButton.open', 'Open with default app')
          : t(
              'auto.components.editor.BinaryFileDefaultAppButton.downloadOpen',
              'Download & open with default app'
            )}
      </Button>
      {openFailed && (
        <p className="text-xs text-muted-foreground" role="alert">
          {t(
            'auto.components.editor.BinaryFileDefaultAppButton.openFailed',
            'No app on this computer opened this file.'
          )}
        </p>
      )}
    </div>
  )
}
