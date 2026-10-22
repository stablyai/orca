import { defaultUrlTransform } from 'react-markdown'
import { EXTERNAL_EDITOR_URI_SCHEMES } from '../../../../shared/external-editor-uri-schemes'

export function markdownPreviewUrlTransform(value: string, key: string): string {
  if (key === 'href' || key === 'src') {
    const lower = value.toLowerCase()
    if (
      lower.startsWith('file:') ||
      EXTERNAL_EDITOR_URI_SCHEMES.some((scheme) => lower.startsWith(scheme))
    ) {
      return value
    }
  }

  return defaultUrlTransform(value)
}
