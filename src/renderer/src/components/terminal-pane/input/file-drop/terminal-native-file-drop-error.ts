import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

type TerminalFileDropErrorKind = 'drop' | 'upload' | 'resolve'

export function terminalFileDropErrorMessage(
  error: unknown,
  kind: TerminalFileDropErrorKind
): string {
  switch (kind) {
    case 'drop':
      return extractIpcErrorMessage(
        error,
        translate('components.toastFallbacks.filesDropFailed', 'Failed to drop files.')
      )
    case 'upload':
      return extractIpcErrorMessage(
        error,
        translate('components.toastFallbacks.filesUploadFailed', 'Failed to upload files.')
      )
    case 'resolve':
      return extractIpcErrorMessage(
        error,
        translate(
          'components.toastFallbacks.filesResolveDroppedFailed',
          'Failed to resolve dropped files.'
        )
      )
  }
}
