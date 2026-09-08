const SHA256_PATTERN = /^[a-f0-9]{64}$/
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function matchesMobileWebProtocolToken(value: string, pattern: RegExp): boolean {
  return pattern.exec(value)?.[0] === value
}

export function isMobileWebSha256(value: string): boolean {
  return matchesMobileWebProtocolToken(value, SHA256_PATTERN)
}

export function isMobileWebGitObjectId(value: string): boolean {
  return matchesMobileWebProtocolToken(value, GIT_OBJECT_ID_PATTERN)
}

export function isMobileWebBase64UrlIdentifier(
  value: string,
  minimumLength: number,
  maximumLength = minimumLength
): boolean {
  return (
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    matchesMobileWebProtocolToken(value, BASE64URL_PATTERN)
  )
}

export function isMobileWebBase64(value: string): boolean {
  return matchesMobileWebProtocolToken(value, BASE64_PATTERN)
}
