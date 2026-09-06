const SENSITIVE_QUERY_KEY_PATTERNS = [
  /^auth(?:entication|orization)?$/,
  /^bearer$/,
  /^code$/,
  /^credential(?:s)?$/,
  /^csrf$/,
  /^hmac$/,
  /^id_token$/,
  /^jwt$/,
  /^oauth_state$/,
  /^otp$/,
  /^password$/,
  /^passwd$/,
  /^pwd$/,
  /^refresh_token$/,
  /^secret$/,
  /^security_token$/,
  /^session(?:_?(?:id|token))?$/,
  /^sig(?:nature)?$/,
  /^sid$/,
  /^state$/,
  /^(?:access_|auth_)?token$/,
  /^api_?key$/,
  /^client_secret$/,
  /^private_key$/,
  /(?:^|_)(?:credential|password|passwd|secret|signature|token)$/,
  /^x_amz_/,
  /^x_goog_(?:credential|signature)$/
]

export const MOBILE_WEB_PAGE_BROWSER_URL_MAX_LENGTH = 4096

export function mobileWebPageBrowserUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MOBILE_WEB_PAGE_BROWSER_URL_MAX_LENGTH
  ) {
    return 'about:blank'
  }
  if (value === 'about:blank') {
    return value
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'file:') {
      return 'file:///[redacted]'
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'about:blank'
    }
    if (
      !parsed.username &&
      !parsed.password &&
      !queryContainsCredential(parsed.searchParams) &&
      !fragmentContainsCredential(parsed.hash)
    ) {
      return value
    }
    parsed.username = ''
    parsed.password = ''
    for (const key of new Set(parsed.searchParams.keys())) {
      if (isSensitiveQueryKey(key)) {
        parsed.searchParams.delete(key)
      }
    }
    if (fragmentContainsCredential(parsed.hash)) {
      parsed.hash = ''
    }
    const sanitized = parsed.toString()
    return sanitized.length <= MOBILE_WEB_PAGE_BROWSER_URL_MAX_LENGTH ? sanitized : 'about:blank'
  } catch {
    return 'about:blank'
  }
}

export function isMobileWebPageBrowserNavigationUrl(value: string): boolean {
  if (value.length > MOBILE_WEB_PAGE_BROWSER_URL_MAX_LENGTH) {
    return false
  }
  if (value === 'about:blank') {
    return true
  }
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password &&
      !queryContainsCredential(parsed.searchParams) &&
      !fragmentContainsCredential(parsed.hash)
    )
  } catch {
    return false
  }
}

function isSensitiveQueryKey(key: string): boolean {
  const normalized = key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
  return SENSITIVE_QUERY_KEY_PATTERNS.some((pattern) => pattern.test(normalized))
}

function queryContainsCredential(query: URLSearchParams): boolean {
  for (const key of query.keys()) {
    if (isSensitiveQueryKey(key)) {
      return true
    }
  }
  return false
}

function fragmentContainsCredential(fragment: string): boolean {
  if (!fragment) {
    return false
  }
  const decoded = safelyDecodeURIComponent(fragment.slice(1)).toLowerCase()
  const keys = decoded
    .split(/[?&;]/)
    .map((part) => part.split('=', 1)[0]!.trim().replaceAll('-', '_'))
  return keys.some(isSensitiveQueryKey)
}

function safelyDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
