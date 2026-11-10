import type { FileOpenFailure } from '@/components/terminal-pane/links/files/terminal-file-open-failure'
import {
  showFileLinkFolderUnavailableToast,
  showFileLinkNotFoundToast,
  showFileLinkUnverifiableToast
} from '@/components/native-chat/links/actions/native-chat-file-link-toasts'

export function showFileLinkOpenFailureToast(filePath: string, failure: FileOpenFailure): void {
  if (failure.verdict === 'unavailable') {
    showFileLinkFolderUnavailableToast(filePath)
  } else if (failure.verdict === 'unverifiable') {
    showFileLinkUnverifiableToast(filePath, failure.error)
  } else {
    showFileLinkNotFoundToast(filePath)
  }
}
