import { defaultUrlTransform } from 'react-markdown'
import { isExternalEditorFileDeepLinkHref } from '../../../../shared/external-editor-uri-schemes'

export function markdownPreviewUrlTransform(value: string, key: string): string {
  if ((key === 'href' || key === 'src') && value.toLowerCase().startsWith('file:')) {
    return value
  }
  // Why: other editor authorities reach extension URI handlers, so they never become links.
  if (key === 'href' && isExternalEditorFileDeepLinkHref(value)) {
    return value
  }

  return defaultUrlTransform(value)
}
