/** A user-defined AI provider account whose usage % Orca polls and shows in the status bar.
 *  No universal usage-API shape exists across vendors, so the response mapping is a small,
 *  deliberately constrained grammar (dot keys + numeric array indices) rather than full
 *  JSONPath/JMESPath — see custom-provider-fetcher.ts. */
export type CustomProviderUsageMappingMode = 'percent' | 'used-limit'

export type CustomProviderAccount = {
  id: string
  displayName: string
  enabled: boolean
  /** Preset icon-catalog id (see custom-provider-icon-options.ts) — never raw SVG. */
  icon?: string
  /** May contain {yyyy}/{mm}/{dd}, substituted with today's UTC date before each call. */
  usageUrl: string
  /** Optional env var name — if it resolves to a non-empty value at fetch time (main
   *  process env), it's used as the Bearer token instead of the keychain-stored one. */
  tokenEnvVar?: string
  mappingMode: CustomProviderUsageMappingMode
  /** 'percent' mode: path to a 0-100 number. */
  percentPath?: string
  /** 'used-limit' mode: 1-4 paths summed as the used amount. */
  usedPaths?: string[]
  /** 'used-limit' mode: path to the limit; percent = min(100, sum(usedPaths) / limit * 100). */
  limitPath?: string
  createdAt: number
  updatedAt: number
}

export type CustomProviderUsageFailureKind =
  | 'missing-token'
  | 'unauthorized'
  | 'network'
  | 'timeout'
  | 'non-json'
  | 'path-not-found'
  | 'invalid-path-syntax'
  | 'non-numeric'
  | 'invalid-limit'
  | 'out-of-range'
  | 'unknown'

export type CustomProviderUsageResult = {
  accountId: string
  usedPercent: number | null
  resetsAt: number | null
  updatedAt: number
  error: string | null
  status: 'ok' | 'error' | 'unavailable' | 'fetching'
  failureKind?: CustomProviderUsageFailureKind
}
