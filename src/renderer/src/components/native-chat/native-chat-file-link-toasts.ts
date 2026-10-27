import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/lib/ipc-error'

export function showFileLinkNotFoundToast(filePath: string): void {
  toast.error(
    translate('components.native-chat.fileLinks.notFound', 'File not found: {{value0}}', {
      value0: filePath
    })
  )
}

/** The host could not be asked whether the file exists, so the toast must not claim it is gone. */
export function showFileLinkUnverifiableToast(filePath: string, error: unknown): void {
  toast.error(
    translate(
      'components.native-chat.fileLinks.unverifiable',
      "Couldn't check {{value0}}: {{value1}}",
      {
        value0: filePath,
        value1: readIpcErrorMessage(error) ?? String(error)
      }
    )
  )
}

/** e.g. `~/x` when the workspace gives no way to know the home folder. */
export function showFileLinkUnresolvedToast(pathText: string): void {
  toast.error(
    translate(
      'components.native-chat.fileLinks.unresolved',
      "Couldn't resolve {{value0}} in this workspace",
      { value0: pathText }
    )
  )
}
