// Classic SSH hosts (no Orca server): sign-in status and code sign-in run over the existing SSH
// remote exec (agent-accounts spec v4 §4 annotations 4–5, Q8). Verdicts and links only: a token,
// a pasted code or CLI output never crosses to the renderer except the code the person typed.
import type { HostAgentSignInAgent, HostAgentSignInReport } from './host-agent-sign-in-status'

export type SshAgentSignInStatusResult =
  | { ok: true; report: HostAgentSignInReport }
  /** `disconnected`: never connected to check. `unknown`: the host didn't answer. */
  | { ok: false; error: 'disconnected' | 'unknown' }

export type SshAgentSignInFlowPhase =
  | 'starting'
  /** Claude: open `url` (claude.ai), approve, paste the code shown there. */
  | 'needsCode'
  | 'submitting'
  /** Codex: enter `userCode` at `url` (auth.openai.com). */
  | 'device'
  | 'signedIn'
  | 'failed'
  | 'cancelled'

export type SshAgentSignInFlowError =
  | 'disconnected'
  | 'notInstalled'
  | 'timeout'
  | 'rejected'
  | 'failed'
  | 'busy'

export type SshAgentSignInFlow = {
  flowId: string
  targetId: string
  agent: HostAgentSignInAgent
  phase: SshAgentSignInFlowPhase
  url?: string
  userCode?: string
  error?: SshAgentSignInFlowError
}
