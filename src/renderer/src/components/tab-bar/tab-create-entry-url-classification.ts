import { translate } from '@/i18n/i18n'

const HOST_FILE_EXTENSIONS = new Set([
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

const LOCAL_ADDRESS_PATTERN =
  /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i

const LOCALHOST_WITH_PORT_PATTERN = /^localhost(?::\d{1,5})?$/i
const IPV4_WITH_PORT_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?$/
const DOMAIN_WITH_PORT_PATTERN =
  /^(?=.{1,253}(?::\d{1,5})?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?$/i

export type ExplicitUrlClassification =
  | { kind: 'blocked'; message: string }
  | { kind: 'explicit-url'; url: string }

export type HostUrlClassification = { kind: 'host-url'; url: string }

export function classifyExplicitUrl(query: string): ExplicitUrlClassification | null {
  // Local dev inputs are handled by host-url classification so users can
  // enter localhost/IP addresses without an explicit scheme.
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

function classifyLocalDevUrl(query: string): HostUrlClassification | null {
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

function classifyHostLikeUrl(query: string): HostUrlClassification | null {
  if (/[\\/]/.test(query) || /\s/.test(query)) {
    return null
  }
  const extension = query.split(':')[0]?.split('.').pop()?.toLowerCase() ?? ''
  if (HOST_FILE_EXTENSIONS.has(extension)) {
    return null
  }
  if (
    !LOCALHOST_WITH_PORT_PATTERN.test(query) &&
    !IPV4_WITH_PORT_PATTERN.test(query) &&
    !DOMAIN_WITH_PORT_PATTERN.test(query)
  ) {
    return null
  }
  try {
    const url = new URL(`https://${query}`)
    return url.hostname ? { kind: 'host-url', url: url.href } : null
  } catch {
    return null
  }
}

export function classifyHostUrl(query: string): HostUrlClassification | null {
  // Try exact local-dev forms first so localhost keeps http:// parity with
  // the previous inline classifier before falling back to public hostnames.
  return classifyLocalDevUrl(query) ?? classifyHostLikeUrl(query)
}
