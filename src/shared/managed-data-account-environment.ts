import { z } from 'zod'

const originalEnvironment = z.object({
  XDG_DATA_HOME: z.string().nullable(),
  XDG_STATE_HOME: z.string().nullable(),
  OPENCODE_AUTH_CONTENT: z.string().nullable(),
  OPENCODE_DB: z.string().nullable(),
  inlineAuthReference: z.uuid().optional()
})
const ORIGINAL_ENV = 'ORCA_DATA_ACCOUNT_ORIGINAL_ENV'
export const MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_DB'
] as const

export function captureManagedDataAccountOriginalEnvironment(
  environment: Record<string, string>,
  inlineAuthReference?: string
): void {
  environment[ORIGINAL_ENV] = JSON.stringify({
    ...Object.fromEntries(
      MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS.map((key) => [key, environment[key] ?? null])
    ),
    OPENCODE_AUTH_CONTENT: environment.OPENCODE_AUTH_CONTENT === '' ? '' : null,
    ...(inlineAuthReference ? { inlineAuthReference } : {})
  })
}

export function restoreManagedDataAccountEnvironment(
  environment: Record<string, string | undefined>,
  restoreOriginal = true,
  resolveInlineAuth?: (reference: string) => string | undefined
): void {
  const provider = environment.ORCA_DATA_ACCOUNT_PROVIDER
  const dataHome = environment.ORCA_DATA_ACCOUNT_DATA_HOME
  if (!dataHome || (provider !== undefined && provider !== 'opencode' && provider !== 'devin')) {
    return
  }
  let original: z.infer<typeof originalEnvironment> | undefined
  try {
    const parsed = originalEnvironment.safeParse(JSON.parse(environment[ORIGINAL_ENV] ?? 'null'))
    if (restoreOriginal && parsed.success) {
      original = parsed.data
    }
  } catch {
    // Older panes have no baseline snapshot; strip only their owned overrides.
  }
  const ownsOpenCode =
    provider === 'opencode' &&
    environment.XDG_DATA_HOME === dataHome &&
    environment.ORCA_DATA_ACCOUNT_STATE_HOME !== undefined &&
    environment.XDG_STATE_HOME === environment.ORCA_DATA_ACCOUNT_STATE_HOME
  const inlineAuth =
    ownsOpenCode && environment.OPENCODE_AUTH_CONTENT === '' && original?.inlineAuthReference
      ? resolveInlineAuth?.(original.inlineAuthReference)
      : original?.OPENCODE_AUTH_CONTENT
  function restore(
    key: (typeof MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS)[number],
    ownedValue: string | undefined
  ): void {
    if (ownedValue === undefined || environment[key] !== ownedValue) {
      return
    }
    const value = key === 'OPENCODE_AUTH_CONTENT' ? inlineAuth : original?.[key]
    if (typeof value === 'string') {
      environment[key] = value
    } else {
      delete environment[key]
    }
  }
  restore('XDG_DATA_HOME', dataHome)
  restore('XDG_STATE_HOME', environment.ORCA_DATA_ACCOUNT_STATE_HOME)
  if (ownsOpenCode) {
    restore('OPENCODE_AUTH_CONTENT', '')
    restore('OPENCODE_DB', 'opencode.db')
  }
  delete environment.ORCA_DATA_ACCOUNT_DATA_HOME
  delete environment.ORCA_DATA_ACCOUNT_STATE_HOME
  delete environment.ORCA_DATA_ACCOUNT_PROVIDER
  delete environment[ORIGINAL_ENV]
}
