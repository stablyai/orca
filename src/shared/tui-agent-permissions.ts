import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './types'

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
  trae: '--yolo'
}

/** Vendor-verified intermediate presets; agents missing from this map fall back to manual. */
export const AUTO_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--permission-mode auto',
  codex: '--approve-for-me',
  grok: '--permission-mode auto'
}

export const YOLO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'auto' }
}

const PERMISSION_AGENT_IDS = Object.keys(TUI_AGENT_CONFIG).filter(
  (agent): agent is TuiAgent => agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
)

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

function isKnownPermissionArgsPreset(agent: TuiAgent, args: string): boolean {
  if (!args) {
    return true
  }
  if (args === (YOLO_TUI_AGENT_ARGS[agent] ?? '')) {
    return true
  }
  return args === (AUTO_TUI_AGENT_ARGS[agent] ?? '')
}

function isKnownPermissionEnvPreset(
  agent: TuiAgent,
  env: Record<string, string> | null | undefined
): boolean {
  return sameEnv(env, {}) || sameEnv(env, YOLO_TUI_AGENT_ENV[agent])
}

function resolveAgentPermissionMode(
  args: string,
  yoloArgs: string,
  autoArgs: string | undefined
): AgentPermissionMode {
  if (!args) {
    return 'manual'
  }
  if (args === yoloArgs) {
    return 'yolo'
  }
  if (autoArgs && args === autoArgs) {
    return 'auto'
  }
  return 'mixed'
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
  let sawYolo = false
  let sawManual = false
  let sawAuto = false
  let sawMixed = false

  for (const mode of modes) {
    if (mode === 'yolo') {
      sawYolo = true
    } else if (mode === 'manual') {
      sawManual = true
    } else if (mode === 'auto') {
      sawAuto = true
    } else {
      sawMixed = true
    }
  }

  if (sawMixed) {
    return 'mixed'
  }
  // Why: Auto only sets verified agents; the rest intentionally stay manual.
  if (sawAuto && !sawYolo) {
    return 'auto'
  }
  if ((sawYolo && sawManual) || (sawYolo && sawAuto)) {
    return 'mixed'
  }
  return sawYolo ? 'yolo' : 'manual'
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

export function resolveAgentPermissionModeSummary(args: {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): AgentPermissionMode {
  const modes: AgentPermissionMode[] = []

  for (const agent of PERMISSION_AGENT_IDS) {
    modes.push(
      resolveTuiAgentPermissionMode({
        agent,
        agentArgs: args.agentDefaultArgs?.[agent],
        agentEnv: args.agentDefaultEnv?.[agent]
      })
    )
  }

  return combinePermissionModes(modes)
}

/** True when the mode auto-resolves tool approvals (yolo or vendor auto). */
export function isAutoApprovingPermissionMode(mode: AgentPermissionMode): boolean {
  return mode === 'yolo' || mode === 'auto'
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
    if (agent in YOLO_TUI_AGENT_ARGS) {
      const currentArgs = normalizeArgs(nextArgs[agent])
      if (isKnownPermissionArgsPreset(agent, currentArgs)) {
        if (args.mode === 'yolo') {
          nextArgs[agent] = YOLO_TUI_AGENT_ARGS[agent] ?? ''
        } else if (args.mode === 'auto') {
          nextArgs[agent] = AUTO_TUI_AGENT_ARGS[agent] ?? ''
        } else {
          nextArgs[agent] = ''
        }
      }
    }

    if (agent in YOLO_TUI_AGENT_ENV) {
      const currentEnv = nextEnv[agent]
      if (isKnownPermissionEnvPreset(agent, currentEnv)) {
        // Why: no verified auto env presets; Auto falls non-env agents back to manual.
        nextEnv[agent] = args.mode === 'yolo' ? { ...YOLO_TUI_AGENT_ENV[agent] } : {}
      }
    }
  }

  return { agentDefaultArgs: nextArgs, agentDefaultEnv: nextEnv }
}
