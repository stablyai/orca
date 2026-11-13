// Orca Cloud agent accounts (agent-accounts spec §5 S0, contract D11): wire shapes of
// /v1/agent-credentials and /v1/agent-sources, and the states main reports to the renderer.
// Nothing here carries a credential: responses and IPC replies are states, labels and codes only.
import { z } from 'zod'

export const ORCA_CLOUD_ACCOUNT_AGENTS = ['claude', 'codex'] as const
export type OrcaCloudAccountAgent = (typeof ORCA_CLOUD_ACCOUNT_AGENTS)[number]

export function isOrcaCloudAccountAgent(value: unknown): value is OrcaCloudAccountAgent {
  return value === 'claude' || value === 'codex'
}

/** A Claude setup-token, exactly as the control plane accepts it (PUT /v1/agent-credentials/claude). */
export const CLAUDE_SETUP_TOKEN_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{20,500}$/

export const AGENT_CREDENTIAL_STATES = ['none', 'active', 'expiring', 'expired', 'revoked'] as const
export type AgentCredentialState = (typeof AGENT_CREDENTIAL_STATES)[number]

/** Active or expiring: the stored credential still works for a request now. */
export function isUsableAgentCredential(state: AgentCredentialState): boolean {
  return state === 'active' || state === 'expiring'
}

const CredentialView = z.object({
  // An unknown future state reads as none rather than failing the whole view.
  state: z.enum(AGENT_CREDENTIAL_STATES).catch('none'),
  label: z.string().max(200).optional(),
  expiresAt: z.number().finite().optional()
})
export type AgentCredentialView = z.infer<typeof CredentialView>

// An unknown future state reads as the kill switch: unusable, and worded as temporary.
const ProviderState = z.enum(['on', 'off', 'disabled']).catch('disabled')
export type OrcaCloudProviderState = z.infer<typeof ProviderState>

export const AgentCredentialsResponseSchema = z.object({
  claude: CredentialView,
  codex: CredentialView,
  /** false: the provider's Orca-account path is unusable (flag off or kill switch; see providerState). */
  providerEnabled: z.object({ claude: z.boolean(), codex: z.boolean() }),
  /**
   * Why: `off` = never offered on this server (flag S1/S2 off), `disabled` = the kill switch (spec §5c).
   * Older servers omit it; read it through `orcaCloudProviderState`.
   */
  providerState: z.object({ claude: ProviderState, codex: ProviderState }).optional()
})
export type AgentCredentialsView = z.infer<typeof AgentCredentialsResponseSchema>

/** The provider's state; without `providerState` (older server) a disabled provider reads as the kill switch. */
export function orcaCloudProviderState(
  view: AgentCredentialsView,
  agent: OrcaCloudAccountAgent
): OrcaCloudProviderState {
  const state = view.providerState?.[agent]
  if (state) {
    // Never trust a state that contradicts providerEnabled.
    return view.providerEnabled[agent] ? 'on' : state === 'on' ? 'disabled' : state
  }
  return view.providerEnabled[agent] ? 'on' : 'disabled'
}

const Source = z.enum(['sign-in', 'key']).nullable()
export type AgentSource = z.infer<typeof Source>
const PerAgentSource = z.object({ claude: Source.optional(), codex: Source.optional() })

export const AgentSourcesResponseSchema = z.looseObject({
  /** The default Source ("New cloud workspaces"); null = never chosen. */
  defaults: PerAgentSource,
  effective: z
    .object({
      claude: z.looseObject({ source: Source }).optional(),
      codex: z.looseObject({ source: Source }).optional()
    })
    .optional(),
  /** Some agent key the caller's workspaces would get covers the agent. */
  coveredByKey: z.object({ claude: z.boolean(), codex: z.boolean() }),
  sharedWorkspace: z.boolean().optional()
})
export type AgentSourcesView = z.infer<typeof AgentSourcesResponseSchema>

export const CodexBrokerStartResponseSchema = z.object({
  // Used in a request path: a leading letter or digit, so never '.' or '..'.
  brokerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  verificationUrl: z.string().url().max(512),
  userCode: z.string().min(1).max(64),
  expiresAt: z.number().finite()
})
export type CodexBrokerStart = z.infer<typeof CodexBrokerStartResponseSchema>

export const CodexBrokerStatusResponseSchema = z.object({
  status: z.enum(['pending', 'active', 'failed']),
  error: z.string().max(64).optional()
})
export type CodexBrokerStatus = z.infer<typeof CodexBrokerStatusResponseSchema>

/** Which kind of key covers an agent, for "using the team key" / "using your API key". */
export type AgentKeyKind = 'team' | 'repository' | 'personal'

/** One read for S0 and the composer's Agent row. */
export type OrcaCloudAgentsStatus = {
  credentials: AgentCredentialsView
  sources: AgentSourcesView
}

/** Codes the renderer turns into copy; never a server message, which could quote input. */
export const ORCA_CLOUD_AGENTS_ERROR_CODES = [
  'signed_out',
  'not_configured',
  /** The provider's flag is off or its kill switch is on (404 from the credential routes). */
  'not_enabled',
  'invalid_token',
  /** A pasted sign-in code that isn't one (Claude's "Paste this into Claude Code" page). */
  'invalid_code',
  'not_found',
  'broker_in_progress',
  'rate_limited',
  'broker_unavailable',
  /** RS-3: the ChatGPT account has device-code sign-in turned off (the Codex broker can't print a code). */
  'device_auth_disabled',
  'no_golden_image',
  'timeout',
  'unavailable',
  'unknown'
] as const
export type OrcaCloudAgentsErrorCode = (typeof ORCA_CLOUD_AGENTS_ERROR_CODES)[number]

export type OrcaCloudAgentsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OrcaCloudAgentsErrorCode }

/** Why a setup on this computer stopped (the runner and the broker driver). */
export const ORCA_CLOUD_AGENT_SETUP_FAILURES = [
  /** `claude` isn't installed here: the row offers the paste fallback. */
  'no_cli',
  'denied',
  'timed_out',
  /** setup-token finished but Orca couldn't read a token from it: the row offers the paste fallback. */
  'capture_failed',
  /** Codex: the device code expired before it was approved. */
  'code_expired',
  /** Codex: the login wasn't a ChatGPT account. */
  'not_a_chatgpt_login',
  'store_failed'
] as const
export type OrcaCloudAgentSetupFailure =
  | (typeof ORCA_CLOUD_AGENT_SETUP_FAILURES)[number]
  | OrcaCloudAgentsErrorCode

/** The one setup step running on this computer for an agent (spec §5 state 6). */
export type OrcaCloudAgentSetup =
  | { phase: 'idle' }
  /**
   * Claude: setup-token is running and the browser is open ("Finish in your browser"). `acceptsCode`:
   * the CLI is waiting for the code Claude's sign-in page shows; `code` is the pasted one's progress.
   */
  | {
      phase: 'browser'
      startedAt: number
      canReopen: boolean
      acceptsCode?: boolean
      code?: 'checking' | 'rejected'
    }
  /** Codex: the broker is starting. */
  | { phase: 'preparing'; startedAt: number }
  /** Codex: enter the code on the provider's page. The code is meant to be shown; it isn't a secret. */
  | {
      phase: 'device'
      startedAt: number
      userCode: string
      verificationUrl: string
      expiresAt: number
    }
  /** Claude: paste a setup-token instead (capture failed, no CLI, or chosen). */
  | {
      phase: 'paste'
      reason: 'capture_failed' | 'no_cli' | 'chosen'
      /** The last pasted token was refused; cleared by the next paste. */
      token?: 'rejected'
    }
  | { phase: 'saving' }
  /** Just stored; the renderer re-reads the credentials (and may ask the state-7 Source question). */
  | { phase: 'saved' }
  | { phase: 'failed'; error: OrcaCloudAgentSetupFailure }

export type OrcaCloudAgentSetups = Record<OrcaCloudAccountAgent, OrcaCloudAgentSetup>

export const IDLE_ORCA_CLOUD_AGENT_SETUPS: OrcaCloudAgentSetups = {
  claude: { phase: 'idle' },
  codex: { phase: 'idle' }
}
