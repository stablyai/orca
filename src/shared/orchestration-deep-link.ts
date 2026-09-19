const PRODUCTION_HOSTS = new Set(['app.orca.dev', 'share.onorca.dev'])

export type OrchestrationDeepLink = {
  type: 'orchestration-new'
  title?: string
  repo?: string
  prompt?: string
  objective?: string
}

function sanitizeField(value: string | null, maxLength = 1024): string | undefined {
  if (!value) {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.slice(0, maxLength)
}

export function parseOrchestrationDeepLink(value: string): OrchestrationDeepLink | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  const isOrcaScheme = url.protocol === 'orca:'
  const isDevelopmentHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const isApprovedHttps =
    (url.protocol === 'https:' && PRODUCTION_HOSTS.has(url.hostname)) ||
    (url.protocol === 'http:' && isDevelopmentHost) ||
    (url.protocol === 'https:' && isDevelopmentHost)

  if (!isOrcaScheme && !isApprovedHttps) {
    return null
  }

  // Normalize path without leading or trailing slashes
  const rawPath = isOrcaScheme
    ? `${url.host}${url.pathname}`.replace(/^\/+/, '').replace(/\/+$/, '')
    : url.pathname.replace(/^\/+/, '').replace(/\/+$/, '')

  const segments = rawPath.split('/')
  if (segments.length !== 2) {
    return null
  }
  const domain = segments[0]
  const action = segments[1]

  if (domain === 'orchestration' && (action === 'new' || action === 'run' || action === 'create')) {
    const title = sanitizeField(url.searchParams.get('title'), 256)
    const repo = sanitizeField(url.searchParams.get('repo'), 256)
    const prompt = sanitizeField(url.searchParams.get('prompt'), 4096)
    const objective = sanitizeField(url.searchParams.get('objective'), 1024)

    return {
      type: 'orchestration-new',
      ...(title ? { title } : {}),
      ...(repo ? { repo } : {}),
      ...(prompt ? { prompt } : {}),
      ...(objective ? { objective } : {})
    }
  }

  return null
}

export function orchestrationDeepLinkFromArguments(
  argv: readonly string[]
): OrchestrationDeepLink | null {
  for (const value of argv) {
    const link = parseOrchestrationDeepLink(value)
    if (link && (value.startsWith('orca:') || value.includes('/orchestration/'))) {
      return link
    }
  }
  return null
}
