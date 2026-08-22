import type { ResumableTuiAgent } from '../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'

// Why: every agent added to RESUMABLE_TUI_AGENTS after agent-session.host-authority.v1 widens the
// host's ensureAgentSession enum. An older host answers the unknown member with invalid_argument,
// which runRemoteAgentSessionLaunch does not treat as a fallback signal, so the pane dies instead
// of degrading to a legacy launch. Probing the agent's own capability keeps version skew safe.
// The exhaustive Record makes the next RESUMABLE_TUI_AGENTS entry a compile error until its own
// gate — or a deliberate `undefined` — is declared here.
const RESUME_HOST_AUTHORITY_CAPABILITY_BY_AGENT = {
  // These shipped inside agent-session.host-authority.v1's enum, so the generic probe covers them.
  claude: undefined,
  codex: undefined,
  gemini: undefined,
  antigravity: undefined,
  opencode: undefined,
  pi: undefined,
  'mimo-code': undefined,
  droid: undefined,
  grok: undefined,
  devin: undefined,
  // Pre-existing gap: prime-agent joined the enum after host-authority.v1 and was never gated.
  // Left as-is here so this change stays a Kimi fix; tracked for a follow-up.
  'prime-agent': undefined,
  omp: AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  kimi: AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY
} satisfies Record<ResumableTuiAgent, RuntimeCapability | undefined>

export function agentResumeHostAuthorityCapability(
  agent: TuiAgent | null | undefined
): RuntimeCapability | undefined {
  if (!agent) {
    return undefined
  }
  return (
    RESUME_HOST_AUTHORITY_CAPABILITY_BY_AGENT as Partial<Record<TuiAgent, RuntimeCapability>>
  )[agent]
}
