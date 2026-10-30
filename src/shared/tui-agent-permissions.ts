import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

export type AgentPermissionMode = 'yolo' | 'manual' | 'auto' | 'mixed'

export const AUTO_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--permission-mode auto',
  'claude-agent-teams': '--permission-mode auto',
  codex: '--approve-for-me'
}

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
  junie: '--brave',
  ante: '--yolo',
  trae: '--yolo',
  droid: '--auto high'
}

export const YOLO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'auto' }
}

const PERMISSION_AGENT_IDS = Object.keys(TUI_AGENT_CONFIG).filter(
  (agent): agent is TuiAgent => agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
)

export function hasConfigurableTuiAgentPermissions(agent: TuiAgent): boolean {
  return agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
}

function normalizeArgs(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

function sameEnv(
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  if (leftEntries.length !== rightEntries.length) {
    return false
  }
  return leftEntries.every(([name, value]) => right?.[name] === value)
}

function resolveAgentPermissionMode(
  args: string,
  yoloArgs: string,
  autoArgs: string | undefined
): AgentPermissionMode {
  if (!args) {
    return 'manual'
  }
  return args === yoloArgs ? 'yolo' : args === autoArgs ? 'auto' : 'mixed'
}

function resolveAgentEnvPermissionMode(
  env: Record<string, string> | null | undefined,
  yoloEnv: Record<string, string> | undefined
): AgentPermissionMode {
  if (sameEnv(env, {})) {
    return 'manual'
  }
  return sameEnv(env, yoloEnv) ? 'yolo' : 'mixed'
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
    modes.push(
      resolveAgentPermissionMode(
        normalizeArgs(args.agentArgs),
        YOLO_TUI_AGENT_ARGS[args.agent] ?? '',
        AUTO_TUI_AGENT_ARGS[args.agent]
      )
    )
  }
  if (args.agent in YOLO_TUI_AGENT_ENV) {
    modes.push(resolveAgentEnvPermissionMode(args.agentEnv, YOLO_TUI_AGENT_ENV[args.agent]))
  }

  return combinePermissionModes(modes)
}

type AgentPermissionSettings = {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}

// Custom launch arguments are left alone by every bulk change, so they don't count toward the summary.
function presetPermissionModes(
  args: AgentPermissionSettings
): { agent: TuiAgent; mode: Exclude<AgentPermissionMode, 'mixed'> }[] {
  const result: { agent: TuiAgent; mode: Exclude<AgentPermissionMode, 'mixed'> }[] = []
  for (const agent of PERMISSION_AGENT_IDS) {
    const mode = resolveTuiAgentPermissionMode({
      agent,
      agentArgs: args.agentDefaultArgs?.[agent],
      agentEnv: args.agentDefaultEnv?.[agent]
    })
    if (mode !== 'mixed') {
      result.push({ agent, mode })
    }
  }
  return result
}

export function resolveAgentPermissionModeSummary(
  args: AgentPermissionSettings
): AgentPermissionMode {
  const presets = presetPermissionModes(args)
  const autoModes = presets.filter(({ agent }) => agent in AUTO_TUI_AGENT_ARGS)
  // Auto changes only supporting agents, so the rest keep their existing permission policy.
  if (autoModes.length > 0 && autoModes.every(({ mode }) => mode === 'auto')) {
    return 'auto'
  }
  return combinePermissionModes(presets.map(({ mode }) => mode))
}

/** Combined mode of preset agents Auto doesn't cover, so the UI can say what they still use. */
export function resolveNonAutoAgentPermissionMode(
  args: AgentPermissionSettings
): 'manual' | 'yolo' | 'mixed' {
  const modes = new Set<AgentPermissionMode>()
  for (const { agent, mode } of presetPermissionModes(args)) {
    if (!(agent in AUTO_TUI_AGENT_ARGS)) {
      modes.add(mode)
    }
  }
  // No preset left to describe (all custom arguments) reads as no single mode.
  if (modes.size !== 1) {
    return 'mixed'
  }
  return modes.has('yolo') ? 'yolo' : 'manual'
}

export function applyAgentPermissionMode(args: {
  mode: Exclude<AgentPermissionMode, 'mixed'>
  agent?: TuiAgent
  /** Leave Auto-capable agents as they are, e.g. to change only the agents Auto doesn't cover. */
  exceptAuto?: boolean
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): {
  agentDefaultArgs: Partial<Record<TuiAgent, string>>
  agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>>
} {
  const nextArgs = { ...args.agentDefaultArgs }
  const nextEnv = { ...args.agentDefaultEnv }

  const agents = args.agent ? [args.agent] : PERMISSION_AGENT_IDS
  for (const agent of agents) {
    const autoArgs = AUTO_TUI_AGENT_ARGS[agent]
    if ((args.mode === 'auto' && !autoArgs) || (args.exceptAuto && autoArgs)) {
      continue
    }
    if (agent in YOLO_TUI_AGENT_ARGS) {
      const yoloArgs = YOLO_TUI_AGENT_ARGS[agent] ?? ''
      const currentArgs = normalizeArgs(nextArgs[agent])
      if (!currentArgs || currentArgs === yoloArgs || currentArgs === autoArgs) {
        nextArgs[agent] = args.mode === 'yolo' ? yoloArgs : args.mode === 'auto' ? autoArgs : ''
      }
    }

    if (agent in YOLO_TUI_AGENT_ENV) {
      const yoloEnv = YOLO_TUI_AGENT_ENV[agent]
      const currentEnv = nextEnv[agent]
      if (sameEnv(currentEnv, {}) || sameEnv(currentEnv, yoloEnv)) {
        nextEnv[agent] = args.mode === 'yolo' ? { ...yoloEnv } : {}
      }
    }
  }

  return { agentDefaultArgs: nextArgs, agentDefaultEnv: nextEnv }
}
