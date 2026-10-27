import type { ResumableTuiAgent } from '../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_CURSOR_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_QODER_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_QODER_CN_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_QWEN_CODE_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_CODEBUDDY_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_DSH_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_MUSE_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_ZCODE_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_OPENCODE2_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import {
  AGENT_SESSION_HERMES_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_KIRO_RESUME_RUNTIME_CAPABILITY
} from '../../../shared/agent-session-resume-runtime-capabilities'

// New resumable enum members can make older hosts return invalid_argument instead of legacy fallback, killing panes. Probe per-agent capability; exhaustive Record requires an explicit gate or deliberate undefined for additions.
const RESUME_HOST_AUTHORITY_CAPABILITY_BY_AGENT = {
  // These shipped inside agent-session.host-authority.v1's enum, so the generic probe covers them.
  claude: undefined,
  codebuddy: AGENT_SESSION_CODEBUDDY_RESUME_RUNTIME_CAPABILITY,
  codex: undefined,
  cursor: AGENT_SESSION_CURSOR_RESUME_RUNTIME_CAPABILITY,
  qoder: AGENT_SESSION_QODER_RESUME_RUNTIME_CAPABILITY,
  'qoder-cn': AGENT_SESSION_QODER_CN_RESUME_RUNTIME_CAPABILITY,
  'qwen-code': AGENT_SESSION_QWEN_CODE_RESUME_RUNTIME_CAPABILITY,
  gemini: undefined,
  antigravity: undefined,
  opencode: undefined,
  opencode2: AGENT_SESSION_OPENCODE2_RESUME_RUNTIME_CAPABILITY,
  pi: undefined,
  'mimo-code': undefined,
  droid: undefined,
  grok: undefined,
  devin: undefined,
  // Prime-agent hooks and enum shipped together (a1f61ef); no host publishes its session without accepting it.
  'prime-agent': undefined,
  // Ungated to match how main shipped copilot resume; gating it is its own change.
  copilot: undefined,
  muse: AGENT_SESSION_MUSE_RESUME_RUNTIME_CAPABILITY,
  zcode: AGENT_SESSION_ZCODE_RESUME_RUNTIME_CAPABILITY,
  omp: AGENT_SESSION_OMP_RESUME_PATH_RUNTIME_CAPABILITY,
  kimi: AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY,
  dsh: AGENT_SESSION_DSH_RESUME_RUNTIME_CAPABILITY,
  // Why: jcode resumed by id (--resume <id>) through the same host-authority session enum the generic probe covers.
  jcode: undefined,
  kiro: AGENT_SESSION_KIRO_RESUME_RUNTIME_CAPABILITY,
  hermes: AGENT_SESSION_HERMES_RESUME_RUNTIME_CAPABILITY
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
