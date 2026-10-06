// Why: adding kimi to RESUMABLE_TUI_AGENTS grows terminal.ensureAgentSession's enum, and an
// older host answers the unknown member with invalid_argument — a code the launch fallback does
// not retry on — so clients must probe before taking the host-authority path.
export const AGENT_SESSION_CURSOR_RESUME_RUNTIME_CAPABILITY =
  'agent-session.cursor-resume.v1' as const
export const AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY = 'agent-session.kimi-resume.v1' as const
export const AGENT_SESSION_OPENCODE2_RESUME_RUNTIME_CAPABILITY =
  'agent-session.opencode2-resume.v1' as const
export const AGENT_SESSION_MUSE_RESUME_RUNTIME_CAPABILITY = 'agent-session.muse-resume.v1' as const
export const AGENT_SESSION_DSH_RESUME_RUNTIME_CAPABILITY = 'agent-session.dsh-resume.v1' as const
export const AGENT_SESSION_CODEBUDDY_RESUME_RUNTIME_CAPABILITY =
  'agent-session.codebuddy-resume.v1' as const
export const AGENT_SESSION_QODER_CN_RESUME_RUNTIME_CAPABILITY =
  'agent-session.qoder-cn-resume.v1' as const
export const AGENT_SESSION_QWEN_CODE_RESUME_RUNTIME_CAPABILITY =
  'agent-session.qwen-code-resume.v1' as const
export const AGENT_SESSION_QODER_RESUME_RUNTIME_CAPABILITY =
  'agent-session.qoder-resume.v1' as const
export const AGENT_SESSION_ZCODE_RESUME_RUNTIME_CAPABILITY =
  'agent-session.zcode-resume.v1' as const

export const AGENT_SESSION_RESUME_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_KIMI_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_CURSOR_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_OPENCODE2_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_MUSE_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_DSH_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_QODER_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_QODER_CN_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_QWEN_CODE_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_CODEBUDDY_RESUME_RUNTIME_CAPABILITY,
  AGENT_SESSION_ZCODE_RESUME_RUNTIME_CAPABILITY
] as const
