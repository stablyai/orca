import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './types'

export type AgentPermissionMode = 'yolo' | 'manual' | 'mixed'

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
  ante: '--yolo'
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

/**
 * Why: launch configs often append profile/model flags alongside YOLO bypass.
 * Exact string equality would misclassify those as `mixed` and re-enable
 * permission noise. Treat the bypass flag as yolo when present as a whole
 * argv token (or the full args string when the YOLO constant is multi-token).
 */
function argsContainYoloFlag(args: string, yoloArgs: string): boolean {
  if (!yoloArgs) {
    return false
  }
  if (args === yoloArgs) {
    return true
  }
  const tokens = args.split(/\s+/).filter(Boolean)
  const yoloTokens = yoloArgs.split(/\s+/).filter(Boolean)
  if (yoloTokens.length === 1) {
    return tokens.includes(yoloTokens[0]!)
  }
  // Multi-token YOLO constants (e.g. `--auto-approve true`) must appear as a
  // contiguous token sequence so partial flag matches stay non-yolo.
  for (let i = 0; i <= tokens.length - yoloTokens.length; i++) {
    if (yoloTokens.every((token, offset) => tokens[i + offset] === token)) {
      return true
    }
  }
  return false
}

function resolveAgentPermissionMode(args: string, yoloArgs: string): AgentPermissionMode {
  if (!args) {
    return 'manual'
  }
  return argsContainYoloFlag(args, yoloArgs) ? 'yolo' : 'mixed'
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
  let sawMixed = false

  for (const mode of modes) {
    if (mode === 'yolo') {
      sawYolo = true
    } else if (mode === 'manual') {
      sawManual = true
    } else {
      sawMixed = true
    }
  }

  if (sawMixed || (sawYolo && sawManual)) {
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
        YOLO_TUI_AGENT_ARGS[args.agent] ?? ''
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
      const yoloArgs = YOLO_TUI_AGENT_ARGS[agent] ?? ''
      const currentArgs = normalizeArgs(nextArgs[agent])
      if (!currentArgs || currentArgs === yoloArgs) {
        nextArgs[agent] = args.mode === 'yolo' ? yoloArgs : ''
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
