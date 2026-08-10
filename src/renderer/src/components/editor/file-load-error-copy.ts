import { translate } from '@/i18n/i18n'

const PATH_ACCESS_DENIED_PREFIX = 'Access denied: path resolves outside allowed directories'

function unwrapIpcErrorMessage(message: string): string {
  const match = message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : message
}

export function formatFileLoadErrorMessage(message: string): string {
  const unwrapped = unwrapIpcErrorMessage(message)
  if (unwrapped.startsWith(PATH_ACCESS_DENIED_PREFIX)) {
    return translate(
      'auto.components.editor.fileLoadError.pathAccessDenied',
      'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'
    )
  }
  return unwrapped
}
