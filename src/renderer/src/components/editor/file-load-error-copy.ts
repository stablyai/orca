import { translate } from '@/i18n/i18n'
import {
  REMOTE_FILE_CHANGED_DURING_READ_MESSAGE,
  REMOTE_FILE_PAGED_READ_UNSUPPORTED_MESSAGE,
  REMOTE_PATH_IS_DIRECTORY_MESSAGE
} from '@/runtime/files/reads/runtime-paged-file-read'

const PATH_ACCESS_DENIED_PREFIX = 'Access denied: path resolves outside allowed directories'

function unwrapIpcErrorMessage(message: string): string {
  const match = message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : message
}

export function formatFileLoadErrorMessage(message: string): string {
  const unwrapped = unwrapIpcErrorMessage(message)
  const missingFile = unwrapped.match(/^ENOENT: no such file or directory, open ([\s\S]+)$/)
  if (missingFile) {
    return translate(
      'auto.components.editor.fileLoadError.fileNotFound',
      'ENOENT: no such file or directory, open {{path}}',
      { path: missingFile[1] }
    )
  }
  if (unwrapped.startsWith(PATH_ACCESS_DENIED_PREFIX)) {
    return translate(
      'auto.components.editor.fileLoadError.pathAccessDenied',
      'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'
    )
  }
  if (unwrapped === REMOTE_FILE_CHANGED_DURING_READ_MESSAGE) {
    return translate(
      'auto.components.editor.fileLoadError.changedDuringRead',
      'File changed on disk while it was loading. Reload the file to see the latest version.'
    )
  }
  if (unwrapped === REMOTE_PATH_IS_DIRECTORY_MESSAGE) {
    return translate(
      'auto.components.editor.fileLoadError.remotePathIsDirectory',
      'Remote path is a directory'
    )
  }
  if (unwrapped === REMOTE_FILE_PAGED_READ_UNSUPPORTED_MESSAGE) {
    return translate(
      'auto.components.editor.fileLoadError.remotePagedReadUnsupported',
      'Remote file is larger than the 512 KB this Orca server can send. Update the server to open it.'
    )
  }
  const tooLarge = unwrapped.match(
    /^Remote file is too large to open in the editor \((\d+) bytes\)$/
  )
  if (tooLarge) {
    return translate(
      'auto.components.editor.fileLoadError.remoteFileTooLarge',
      'Remote file is too large to open in the editor ({{bytes}} bytes)',
      { bytes: tooLarge[1] }
    )
  }
  return unwrapped
}
