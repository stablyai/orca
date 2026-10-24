import type { FileOpenFailure } from '@/components/terminal-pane/terminal-file-open-routing'
import {
  showFileLinkNotFoundToast,
  showFileLinkUnverifiableToast
} from '@/components/native-chat/native-chat-file-link-toasts'

/** Why a file link opened nothing, without claiming a file is gone when the host could not answer. */
export function showFileLinkOpenFailureToast(filePath: string, failure: FileOpenFailure): void {
  if (failure.verdict === 'unverifiable') {
    showFileLinkUnverifiableToast(filePath, failure.error)
  } else {
    showFileLinkNotFoundToast(filePath)
  }
}
