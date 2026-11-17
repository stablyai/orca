// Agent API keys and the user's Orca account. While signed in, a saved key is also written to
// the personal Cloud secret of the same variable, and this computer's vault stays the sealed cache
// that non-Cloud launches read. Cloud secrets are write-only, so the sync is one way: desktop → account.
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import type { CloudSecretsErrorCode } from '../cloud-secrets/cloud-secrets-wire'
import { cloudSecretSwapped } from '../cloud-secrets/cloud-secret-rules'
import type { AgentApiKeySummary, AgentApiKeysState } from './agent-api-key-catalog'

export type AgentApiKeysCloudState = {
  /** Signed in to an Orca account that has Orca Cloud; otherwise keys stay on this computer only. */
  signedIn: boolean
  /** Signed in, but Orca can't be reached now: `synced`/`managed` are the last-known state. */
  unreachable?: boolean
  /** Keys saved while signed in that haven't reached the account yet; Orca retries them. */
  pending?: string[]
  /** Keys whose current value this computer saved to the Orca account. */
  synced: string[]
  /**
   * Keys whose variable this computer wrote to the Orca account (possibly an older value). Only these
   * may be removed from the account, and only after the user confirms.
   */
  managed: string[]
}

/**
 * What happened in the Orca account. Codes only: never a value. After a save, `failed` means the key
 * is saved on this computer only; after a removal it means nothing was removed. `removed` means a
 * removal also deleted the account copy; `skipped` means the account wasn't touched.
 */
export type AgentApiKeyCloudOutcome =
  | { kind: 'synced' }
  | { kind: 'removed' }
  | { kind: 'skipped' }
  | { kind: 'failed'; error: CloudSecretsErrorCode; keyId?: string }

export type AgentApiKeyRemoveRequest = {
  id: string
  /** Also delete the personal Cloud secret. Honoured only for a key in `managed`. */
  fromAccount: boolean
}

/**
 * How a row describes the key:
 * - `synced`: "Saved in your Orca account · cached on this computer".
 * - `stale`: this computer saved it to the Orca account earlier, but the account holds an older value
 *   or variable (an edit that didn't reach the account, a rename, or a narrower host scope).
 * - `local`: signed in, the key could be used in Orca Cloud but is only on this computer.
 * - `not-swappable`: the egress proxy can't stand in for it, so it is never sent to Orca Cloud.
 * - `none`: signed out, or a key scoped to some hosts; the row reads as it always has.
 */
export type AgentApiKeyCloudRowState = 'synced' | 'stale' | 'local' | 'not-swappable' | 'none'

/** A key the desktop may write to the Orca account: every host, and a variable the proxy swaps. */
export function agentApiKeyCloudEligible(
  key: Pick<AgentApiKeySummary, 'envName' | 'hostScope'>
): boolean {
  return key.hostScope.kind === 'all' && cloudSecretSwapped(key.envName)
}

export function agentApiKeyCloudRowState(
  key: Pick<AgentApiKeySummary, 'id' | 'envName' | 'hostScope'>,
  cloud: AgentApiKeysCloudState | undefined
): AgentApiKeyCloudRowState {
  if (!cloud?.signedIn) {
    return 'none'
  }
  if (cloud.synced.includes(key.id)) {
    return 'synced'
  }
  if (cloud.managed.includes(key.id)) {
    return 'stale'
  }
  if (key.hostScope.kind !== 'all') {
    return 'none'
  }
  return cloudSecretSwapped(key.envName) ? 'local' : 'not-swappable'
}

/** Whether removing this key should ask about the copy in the Orca account. */
export function agentApiKeyRemoveAsksAboutAccount(
  key: Pick<AgentApiKeySummary, 'id'>,
  cloud: AgentApiKeysCloudState | undefined
): boolean {
  return cloud?.signedIn === true && cloud.managed.includes(key.id)
}

export type LocalAgentKeySource = 'opencode-auth' | 'gemini-env-file' | 'shell-env'

/** One key "Import from this Mac" found. Names, source and last four only: the value stays in main. */
type LocalAgentKeyFound = {
  name: string
  agent: TuiAgent
  source: LocalAgentKeySource
  hint: string
  /** The vault already has a key for this agent and variable; import skips it. */
  alreadySaved: boolean
}

/** A subscription sign-in found on this computer. Its tokens are never read. */
export type LocalAgentSignInFound = {
  agent: 'opencode' | 'gemini'
  provider: string
}

export type AgentApiKeysScanResult = {
  keys: LocalAgentKeyFound[]
  signIns: LocalAgentSignInFound[]
}

export type AgentApiKeysImportResult = {
  state: AgentApiKeysState
  imported: string[]
  /** Not saved on this computer; `error` is Orca's own copy, never a value. */
  failed: { name: string; error: string }[]
  /** Saved on this computer, but not to the Orca account. */
  cloudFailed: { name: string; error: CloudSecretsErrorCode }[]
}

export const MAX_AGENT_API_KEY_IMPORT = 16
