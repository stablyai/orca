import { defaultUrlTransform } from 'react-markdown'

export function markdownPreviewUrlTransform(value: string, key: string): string {
  if ((key === 'href' || key === 'src') && value.toLowerCase().startsWith('file:')) {
    return value
  }

  return defaultUrlTransform(value)
}
