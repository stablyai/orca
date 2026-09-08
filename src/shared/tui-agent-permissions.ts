import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

export type AgentPermissionMode = 'yolo' | 'auto' | 'manual' | 'mixed'

export const YOLO_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--dangerously-skip-permissions',
  'claude-agent-teams': '--dangerously-skip-permissions',
  openclaude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
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
  'mistral-vibe': '--agent auto-approve',
  'qwen-code': '--approval-mode yolo',
  rovo: '--yolo',
  hermes: '--yolo',
  copilot: '--yolo',
  grok: '--permission-mode bypassPermissions',
  devin: '--permission-mode bypass',
  ante: '--yolo',
  trae: '--yolo',
  droid: '--auto high'
}

export const YOLO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'auto' }
}

// Only documented intermediate CLI presets belong here; unsupported agents use Manual.
export const AUTO_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--permission-mode auto',
  'claude-agent-teams': '--permission-mode auto',
  codex: '--approve-for-me',
  gemini: '--approval-mode auto_edit',
  'qwen-code': '--approval-mode auto',
  devin: '--permission-mode smart',
  droid: '--auto medium'
}

export const AUTO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'smart_approve' }
}

const PERMISSION_AGENT_IDS = Object.keys(TUI_AGENT_CONFIG).filter(
  (agent): agent is TuiAgent => agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
)

export function supportsTuiAgentAutoPermissionMode(agent: TuiAgent): boolean {
  return agent in AUTO_TUI_AGENT_ARGS || agent in AUTO_TUI_AGENT_ENV
}

function sameEnv(
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {})
  return (
    leftEntries.length === Object.keys(right ?? {}).length &&
    leftEntries.every(([name, value]) => right?.[name] === value)
  )
}

function combinePermissionModes(modes: AgentPermissionMode[]): AgentPermissionMode {
  const distinct = new Set(modes)
  return distinct.size > 1 ? 'mixed' : (modes[0] ?? 'manual')
}

export function resolveTuiAgentPermissionMode(args: {
  agent: TuiAgent
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
}): AgentPermissionMode {
  const modes: AgentPermissionMode[] = []
  if (args.agent in YOLO_TUI_AGENT_ARGS) {
    const value = args.agentArgs ?? ''
    modes.push(
      !value
        ? 'manual'
        : value === YOLO_TUI_AGENT_ARGS[args.agent]
          ? 'yolo'
          : value === AUTO_TUI_AGENT_ARGS[args.agent]
            ? 'auto'
            : 'mixed'
    )
  }
  if (args.agent in YOLO_TUI_AGENT_ENV) {
    modes.push(
      sameEnv(args.agentEnv, {})
        ? 'manual'
        : sameEnv(args.agentEnv, YOLO_TUI_AGENT_ENV[args.agent])
          ? 'yolo'
          : AUTO_TUI_AGENT_ENV[args.agent] && sameEnv(args.agentEnv, AUTO_TUI_AGENT_ENV[args.agent])
            ? 'auto'
            : 'mixed'
    )
  }
  return combinePermissionModes(modes)
}

export function resolveAgentPermissionModeSummary(args: {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): AgentPermissionMode {
  const modes = PERMISSION_AGENT_IDS.map((agent) => ({
    agent,
    mode: resolveTuiAgentPermissionMode({
      agent,
      agentArgs: args.agentDefaultArgs?.[agent],
      agentEnv: args.agentDefaultEnv?.[agent]
    })
  }))
  if (
    modes.some(({ mode }) => mode === 'auto') &&
    modes.every(
      ({ agent, mode }) =>
        mode === 'auto' || (mode === 'manual' && !supportsTuiAgentAutoPermissionMode(agent))
    )
  ) {
    return 'auto'
  }
  return combinePermissionModes(modes.map(({ mode }) => mode))
}

export function applyTuiAgentPermissionMode(args: {
  agent: TuiAgent
  mode: Exclude<AgentPermissionMode, 'mixed'>
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
}): { agentArgs: string; agentEnv: Record<string, string> } {
  let agentArgs = args.agentArgs ?? ''
  let agentEnv = { ...args.agentEnv }
  if (
    args.agent in YOLO_TUI_AGENT_ARGS &&
    (!agentArgs ||
      agentArgs === YOLO_TUI_AGENT_ARGS[args.agent] ||
      agentArgs === AUTO_TUI_AGENT_ARGS[args.agent])
  ) {
    agentArgs =
      (args.mode === 'yolo'
        ? YOLO_TUI_AGENT_ARGS[args.agent]
        : args.mode === 'auto'
          ? AUTO_TUI_AGENT_ARGS[args.agent]
          : '') ?? ''
  }
  if (
    args.agent in YOLO_TUI_AGENT_ENV &&
    (sameEnv(agentEnv, {}) ||
      sameEnv(agentEnv, YOLO_TUI_AGENT_ENV[args.agent]) ||
      (AUTO_TUI_AGENT_ENV[args.agent] && sameEnv(agentEnv, AUTO_TUI_AGENT_ENV[args.agent])))
  ) {
    agentEnv = {
      ...(args.mode === 'yolo'
        ? YOLO_TUI_AGENT_ENV[args.agent]
        : args.mode === 'auto'
          ? AUTO_TUI_AGENT_ENV[args.agent]
          : {})
    }
  }
  return { agentArgs, agentEnv }
}

export function applyAgentPermissionMode(args: {
  mode: Exclude<AgentPermissionMode, 'mixed'>
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): {
  agentDefaultArgs: Partial<Record<TuiAgent, string>>
  agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>>
} {
  const nextArgs = { ...args.agentDefaultArgs }
  const nextEnv = { ...args.agentDefaultEnv }
  for (const agent of PERMISSION_AGENT_IDS) {
    const result = applyTuiAgentPermissionMode({
      agent,
      mode: args.mode,
      agentArgs: nextArgs[agent],
      agentEnv: nextEnv[agent]
    })
    if (agent in YOLO_TUI_AGENT_ARGS) {
      nextArgs[agent] = result.agentArgs
    }
    if (agent in YOLO_TUI_AGENT_ENV) {
      nextEnv[agent] = result.agentEnv
    }
  }
  return { agentDefaultArgs: nextArgs, agentDefaultEnv: nextEnv }
}
