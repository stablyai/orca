import type { TabEntryActionClassification, TabEntryClassification } from './tab-create-entry-classifier'
import { translate } from '@/i18n/i18n'

export const HOST_FILE_EXTENSIONS = new Set([
  'css',
  'html',
  'js',
  'jsx',
  'json',
  'md',
  'py',
  'toml',
  'ts',
  'tsx',
  'yaml',
  'yml'
])

export const LOCAL_ADDRESS_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i

export function classifyExplicitUrl(
  query: string
): Extract<TabEntryClassification, { kind: 'blocked' | 'explicit-url' }> | null {
  if (LOCAL_ADDRESS_PATTERN.test(query)) {
    return null
  }
  let url: URL
  try {
    url = new URL(query)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return {
      kind: 'blocked',
      message: translate(
        'auto.components.tab.bar.tab.create.entry.classifier.90eb94dc48',
        'Enter an http:// or https:// URL.'
      )
    }
  }
  return { kind: 'explicit-url', url: url.href }
}

export function classifyLocalDevUrl(
  query: string
): Extract<TabEntryActionClassification, { kind: 'host-url' }> | null {
  if (!LOCAL_ADDRESS_PATTERN.test(query)) {
    return null
  }
  try {
    const url = new URL(`http://${query}`)
    return url.hostname ? { kind: 'host-url', url: url.href } : null
  } catch {
    return null
  }
}

export function classifyHostLikeUrl(
  query: string
): Extract<TabEntryActionClassification, { kind: 'host-url' }> | null {
  if (/[\\/]/.test(query) || /\s/.test(query)) {
    return null
  }
  const extension = query.split(':')[0]?.split('.').pop()?.toLowerCase() ?? ''
  if (HOST_FILE_EXTENSIONS.has(extension)) {
    return null
  }
  const hostPort = '(?::\\d{1,5})?'
  const localhost = new RegExp(`^localhost${hostPort}$`, 'i')
  const ipv4 = new RegExp(`^(?:\\d{1,3}\\.){3}\\d{1,3}${hostPort}$`)
  const domain = new RegExp(
    `^(?=.{1,253}${hostPort}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,}${hostPort}$`,
    'i'
  )
  if (!localhost.test(query) && !ipv4.test(query) && !domain.test(query)) {
    return null
  }
  try {
    const url = new URL(`https://${query}`)
    return url.hostname ? { kind: 'host-url', url: url.href } : null
  } catch {
    return null
  }
}
