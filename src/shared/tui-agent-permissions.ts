import { TUI_AGENT_CONFIG, isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

/** Whether Orca launches an agent with its permission-bypass flag (`bypass`, shown as Yolo) or without it (`ask`). */
export type AgentPermissionMode = 'bypass' | 'ask'

/** What an untouched profile gets; Orca has shipped agents in Yolo by default. */
export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'bypass'

export const YOLO_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--dangerously-skip-permissions',
  codebuddy: '--dangerously-skip-permissions',
  'claude-agent-teams': '--dangerously-skip-permissions',
  openclaude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  qoder: '--dangerously-skip-permissions',
  'qoder-cn': '--dangerously-skip-permissions',
  gemini: '--yolo',
  antigravity: '--dangerously-skip-permissions',
  aider: '--yes-always',
  amp: '--dangerously-allow-all',
  kiro: '--trust-all-tools',
  crush: '--yolo',
  autohand: '--unrestricted',
  cline: '--auto-approve true',
  'command-code': '--yolo',
  continue: '--allow "*"',
  cursor: '--yolo',
  kimi: '--yolo',
  muse: '--yolo',
  // Why: ZCode gates tools by collaboration mode; `yolo` is its bypass-everything mode.
  zcode: '--mode yolo',
  'mistral-vibe': '--agent auto-approve',
  'qwen-code': '--approval-mode yolo',
  rovo: '--yolo',
  hermes: '--yolo',
  copilot: '--yolo',
  grok: '--permission-mode bypassPermissions',
  devin: '--permission-mode bypass --respect-workspace-trust false',
  ante: '--yolo',
  trae: '--yolo',
  droid: '--auto high'
}

export const YOLO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'auto' }
}

export const PERMISSION_AGENT_IDS: readonly TuiAgent[] = Object.keys(TUI_AGENT_CONFIG).filter(
  (agent): agent is TuiAgent => agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
)

/** One option that sets an agent's permissions, under every spelling (long first). */
export type AgentPermissionOption = {
  names: readonly string[]
  /** Takes a value: `--opt v`, `--opt=v`, or attached to a short name (`-av`). */
  takesValue?: boolean
}

/** An agent's permission options, and each complete setting of them that bypasses permissions. */
export type AgentPermissionArgSpec = {
  options: readonly AgentPermissionOption[]
  /** Each entry bypasses on its own: option (by first name) to its value, `true` for a flag. */
  bypass: readonly Readonly<Record<string, string | true>>[]
}

// `--allow-dangerously-skip-permissions` only permits a later switch into bypass; it sets nothing.
const CLAUDE_PERMISSION_ARGS: AgentPermissionArgSpec = {
  options: [
    { names: ['--dangerously-skip-permissions'] },
    { names: ['--permission-mode'], takesValue: true }
  ],
  bypass: [{ '--dangerously-skip-permissions': true }, { '--permission-mode': 'bypassPermissions' }]
}

const GEMINI_PERMISSION_ARGS: AgentPermissionArgSpec = {
  options: [{ names: ['--yolo', '-y'] }, { names: ['--approval-mode'], takesValue: true }],
  bypass: [{ '--yolo': true }, { '--approval-mode': 'yolo' }]
}

/**
 * Permission options for agents whose Arguments can set permissions beyond their bypass flag;
 * every other agent's are read from its YOLO_TUI_AGENT_ARGS flag alone.
 */
export const AGENT_PERMISSION_ARG_SPECS: Partial<Record<TuiAgent, AgentPermissionArgSpec>> = {
  claude: CLAUDE_PERMISSION_ARGS,
  'claude-agent-teams': CLAUDE_PERMISSION_ARGS,
  openclaude: CLAUDE_PERMISSION_ARGS,
  codex: {
    options: [
      { names: ['--dangerously-bypass-approvals-and-sandbox', '--yolo'] },
      { names: ['--ask-for-approval', '-a'], takesValue: true },
      { names: ['--sandbox', '-s'], takesValue: true },
      { names: ['--full-auto'] }
    ],
    bypass: [
      { '--dangerously-bypass-approvals-and-sandbox': true },
      { '--ask-for-approval': 'never', '--sandbox': 'danger-full-access' }
    ]
  },
  gemini: GEMINI_PERMISSION_ARGS,
  'qwen-code': GEMINI_PERMISSION_ARGS,
  // `--respect-workspace-trust` in Devin's flag only skips the folder-trust prompt (#21925).
  devin: {
    options: [{ names: ['--permission-mode'], takesValue: true }],
    bypass: [{ '--permission-mode': 'bypass' }]
  }
}

/** A stored mode: one of this build's, or one a newer build wrote, which is kept and reads as 'ask'. */
export type StoredAgentPermissionMode = string

/** The persisted permission settings; part of GlobalSettings. Read them through the resolvers. */
export type AgentPermissionSettingsFields = {
  /** Mode every agent launches with unless it has its own override. Absent only on profiles saved
   *  before the mode was typed, which is what the load-time migration keys on. */
  agentPermissionMode?: StoredAgentPermissionMode
  /** Agents whose permission mode differs from `agentPermissionMode`. */
  agentPermissionModeOverrides?: Partial<Record<TuiAgent, StoredAgentPermissionMode>>
}

export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return value === 'bypass' || value === 'ask'
}

export function agentHasPermissionMode(agent: TuiAgent): boolean {
  return agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
}

/** Keeps every known agent's stored mode, including one a newer build wrote. */
export function normalizeAgentPermissionModeOverrides(
  value: unknown
): Partial<Record<TuiAgent, StoredAgentPermissionMode>> {
  const normalized: Partial<Record<TuiAgent, StoredAgentPermissionMode>> = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [agent, mode] of Object.entries(value)) {
    if (isTuiAgent(agent) && typeof mode === 'string') {
      normalized[agent] = mode
    }
  }
  return normalized
}

/** Validates the permission fields of a settings update; an invalid mode is dropped. */
export function normalizeAgentPermissionSettingsUpdate(
  updates: AgentPermissionSettingsFields
): AgentPermissionSettingsFields {
  const normalized: AgentPermissionSettingsFields = {}
  if (isAgentPermissionMode(updates.agentPermissionMode)) {
    normalized.agentPermissionMode = updates.agentPermissionMode
  }
  if ('agentPermissionModeOverrides' in updates) {
    normalized.agentPermissionModeOverrides = normalizeAgentPermissionModeOverrides(
      updates.agentPermissionModeOverrides
    )
  }
  return normalized
}

/** The mode every agent without its own choice launches with. */
export function resolveDefaultAgentPermissionMode(
  settings: AgentPermissionSettingsFields | null | undefined
): AgentPermissionMode {
  const mode = settings?.agentPermissionMode
  return mode === undefined ? DEFAULT_AGENT_PERMISSION_MODE : readStoredMode(mode)
}

// A mode a newer build stored asks here, and stays stored for that build.
function readStoredMode(mode: StoredAgentPermissionMode): AgentPermissionMode {
  return isAgentPermissionMode(mode) ? mode : 'ask'
}

/** The agent's own choice if it has one, else the default every agent shares. */
export function resolveAgentPermissionMode(
  agent: TuiAgent,
  settings: AgentPermissionSettingsFields | null | undefined
): AgentPermissionMode {
  const override = settings?.agentPermissionModeOverrides?.[agent]
  return override === undefined
    ? resolveDefaultAgentPermissionMode(settings)
    : readStoredMode(override)
}
