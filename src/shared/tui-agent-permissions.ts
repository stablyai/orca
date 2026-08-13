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

// Why: agents absent here have no vendor intermediate preset and intentionally stay manual.
export const AUTO_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> = {
  claude: '--permission-mode auto',
  'claude-agent-teams': '--permission-mode auto',
  openclaude: '--permission-mode auto',
  codex: '--approve-for-me',
  antigravity: '--mode=accept-edits',
  gemini: '--approval-mode auto_edit',
  'qwen-code': '--approval-mode auto',
  grok: '--permission-mode auto',
  devin: '--permission-mode smart'
}

export const YOLO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'auto' }
}

// Why: agents absent here have no vendor intermediate preset and intentionally stay manual.
export const AUTO_TUI_AGENT_ENV: Partial<Record<TuiAgent, Record<string, string>>> = {
  goose: { GOOSE_MODE: 'smart_approve' }
}

const PERMISSION_AGENT_IDS = Object.keys(TUI_AGENT_CONFIG).filter(
  (agent): agent is TuiAgent => agent in YOLO_TUI_AGENT_ARGS || agent in YOLO_TUI_AGENT_ENV
)

function normalizeArgs(value: string | null | undefined): string {
  return value ?? ''
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
  return (
    sameEnv(env, {}) ||
    sameEnv(env, YOLO_TUI_AGENT_ENV[agent]) ||
    sameEnv(env, AUTO_TUI_AGENT_ENV[agent])
  )
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
  yoloEnv: Record<string, string> | undefined,
  autoEnv: Record<string, string> | undefined
): AgentPermissionMode {
  if (sameEnv(env, {})) {
    return 'manual'
  }
  if (sameEnv(env, yoloEnv)) {
    return 'yolo'
  }
  return sameEnv(env, autoEnv) ? 'auto' : 'mixed'
}

function combinePermissionModes(
  modes: AgentPermissionMode[],
  sawManualForAutoCapableAgent = false
): AgentPermissionMode {
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
  if (sawAuto) {
    return sawYolo || sawManualForAutoCapableAgent ? 'mixed' : 'auto'
  }
  if (sawYolo && sawManual) {
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
    modes.push(
      resolveAgentEnvPermissionMode(
        args.agentEnv,
        YOLO_TUI_AGENT_ENV[args.agent],
        AUTO_TUI_AGENT_ENV[args.agent]
      )
    )
  }

  return combinePermissionModes(modes)
}

export function resolveAgentPermissionModeSummary(args: {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): AgentPermissionMode {
  const modes: AgentPermissionMode[] = []
  let sawManualForAutoCapableAgent = false

  for (const agent of PERMISSION_AGENT_IDS) {
    const mode = resolveTuiAgentPermissionMode({
      agent,
      agentArgs: args.agentDefaultArgs?.[agent],
      agentEnv: args.agentDefaultEnv?.[agent]
    })
    modes.push(mode)
    if (mode === 'manual' && (agent in AUTO_TUI_AGENT_ARGS || agent in AUTO_TUI_AGENT_ENV)) {
      sawManualForAutoCapableAgent = true
    }
  }

  return combinePermissionModes(modes, sawManualForAutoCapableAgent)
}

export function hasAutoAgentPermissionPreset(args: {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): boolean {
  return PERMISSION_AGENT_IDS.some(
    (agent) =>
      resolveTuiAgentPermissionMode({
        agent,
        agentArgs: args.agentDefaultArgs?.[agent],
        agentEnv: args.agentDefaultEnv?.[agent]
      }) === 'auto'
  )
}

export function projectAgentPermissionSettingsForLegacyClient(args: {
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): {
  agentDefaultArgs: Partial<Record<TuiAgent, string>>
  agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>>
} {
  const agentDefaultArgs = { ...args.agentDefaultArgs }
  const agentDefaultEnv = { ...args.agentDefaultEnv }
  if (!hasAutoAgentPermissionPreset(args)) {
    return { agentDefaultArgs, agentDefaultEnv }
  }
  // Why: legacy onboarding treats unknown Auto presets as Yolo and can widen empty fallbacks.
  for (const agent of PERMISSION_AGENT_IDS) {
    delete agentDefaultArgs[agent]
    delete agentDefaultEnv[agent]
  }
  return { agentDefaultArgs, agentDefaultEnv }
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
      // Why: overwrite only exact presets; whitespace changes are user-authored custom args.
      const currentArgs = nextArgs[agent] ?? ''
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
        if (args.mode === 'yolo') {
          nextEnv[agent] = { ...YOLO_TUI_AGENT_ENV[agent] }
        } else if (args.mode === 'auto') {
          // Why: mirror args branch — auto env preset when verified, else manual {}.
          nextEnv[agent] = AUTO_TUI_AGENT_ENV[agent] ? { ...AUTO_TUI_AGENT_ENV[agent] } : {}
        } else {
          nextEnv[agent] = {}
        }
      }
    }
  }

  return { agentDefaultArgs: nextArgs, agentDefaultEnv: nextEnv }
}
