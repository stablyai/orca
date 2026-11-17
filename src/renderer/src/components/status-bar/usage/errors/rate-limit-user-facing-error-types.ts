export type RateLimitKnownError = {
  test: RegExp | string
  key: string
  fallback: string
  vars?: (match: RegExpMatchArray) => Record<string, string>
}
