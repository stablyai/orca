import { AGENT_CREDENTIAL_NAMES } from './agent-credentials/agent-credential-names'

/** Names only: recipe create scripts get this computer's whole env, so values never leave main. */
export type RecipeForwardedEnvSummary = {
  count: number
  /** Sorted names that look like credentials (key/token/secret/password, or an agent credential). */
  keyLike: string[]
  /** Every other forwarded name, sorted. */
  other: string[]
}

const AGENT_CREDENTIAL_NAME_SET = new Set(Object.values(AGENT_CREDENTIAL_NAMES).flat())
const CREDENTIAL_SEGMENTS = new Set([
  'KEY',
  'KEYS',
  'APIKEY',
  'TOKEN',
  'TOKENS',
  'SECRET',
  'SECRETS',
  'CREDENTIAL',
  'CREDENTIALS',
  'PAT'
])
const CREDENTIAL_SUBSTRINGS = /PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_?KEY/

export function looksLikeCredentialEnvName(name: string): boolean {
  // Windows env names are case-insensitive; match them the way agents would read them.
  const upper = name.toUpperCase()
  return (
    AGENT_CREDENTIAL_NAME_SET.has(upper) ||
    CREDENTIAL_SUBSTRINGS.test(upper) ||
    upper.split(/[_\-.]/).some((segment) => CREDENTIAL_SEGMENTS.has(segment))
  )
}

export function summarizeRecipeForwardedEnv(env: NodeJS.ProcessEnv): RecipeForwardedEnvSummary {
  const names = Object.keys(env)
    .filter((name) => name.length > 0 && env[name] !== undefined)
    .sort((a, b) => a.localeCompare(b))
  return {
    count: names.length,
    keyLike: names.filter(looksLikeCredentialEnvName),
    other: names.filter((name) => !looksLikeCredentialEnvName(name))
  }
}
