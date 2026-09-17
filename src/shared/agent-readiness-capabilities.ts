import type { TuiAgent } from './tui-agent'

export type AgentReadinessEvidence = 'title' | 'screen'
export type AgentPromptReceipt = 'turn-start' | 'input-accepted'
/** How a launch path can reconcile the terminal after a delivery/readiness ambiguity. */
export type AgentTerminalReconciliation = 'pty-incarnation' | 'native-session' | 'unsupported'

export type AgentLaunchPathCapability = {
  /** Whether Orca has a positive readiness observation for this launch path. */
  readiness: 'supported' | 'unsupported'
  evidence: readonly AgentReadinessEvidence[]
  submission: 'pty-composer' | 'native-session'
  receipt: AgentPromptReceipt
  terminalReconciliation: AgentTerminalReconciliation
}

export type AgentReadinessCapability = {
  terminal: AgentLaunchPathCapability
  structured: AgentLaunchPathCapability
}

const unsupportedTerminal: AgentLaunchPathCapability = {
  readiness: 'unsupported',
  evidence: [],
  submission: 'pty-composer',
  receipt: 'input-accepted',
  terminalReconciliation: 'pty-incarnation'
}

const unsupportedStructured: AgentLaunchPathCapability = {
  readiness: 'unsupported',
  evidence: [],
  submission: 'native-session',
  receipt: 'input-accepted',
  terminalReconciliation: 'unsupported'
}

const titleTerminal = (receipt: AgentPromptReceipt = 'input-accepted') => ({
  readiness: 'supported' as const,
  evidence: ['title'] as const,
  submission: 'pty-composer' as const,
  receipt,
  terminalReconciliation: 'pty-incarnation' as const
})

const screenTerminal = (receipt: AgentPromptReceipt = 'input-accepted') => ({
  readiness: 'supported' as const,
  evidence: ['screen'] as const,
  submission: 'pty-composer' as const,
  receipt,
  terminalReconciliation: 'pty-incarnation' as const
})

const structuredSession = {
  readiness: 'supported',
  evidence: [],
  submission: 'native-session',
  receipt: 'turn-start',
  terminalReconciliation: 'native-session'
} as const satisfies AgentLaunchPathCapability

/**
 * The facts Orca can prove for each vendor and launch path.
 *
 * This is deliberately conservative: a vendor with a composer but no captured, attachment-bound
 * readiness signal remains unsupported rather than being promoted by a title or silence guess.
 * `satisfies` keeps additions to TuiAgent from silently escaping the matrix.
 */
export const AGENT_READINESS_CAPABILITIES = {
  claude: { terminal: titleTerminal('turn-start'), structured: structuredSession },
  'claude-agent-teams': { terminal: unsupportedTerminal, structured: unsupportedStructured },
  openclaude: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  codex: {
    terminal: {
      readiness: 'supported',
      evidence: ['title', 'screen'],
      submission: 'pty-composer',
      receipt: 'turn-start',
      terminalReconciliation: 'pty-incarnation'
    },
    structured: structuredSession
  },
  autohand: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  ante: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  trae: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  opencode: { terminal: titleTerminal(), structured: unsupportedStructured },
  'mimo-code': { terminal: unsupportedTerminal, structured: unsupportedStructured },
  pi: { terminal: titleTerminal(), structured: unsupportedStructured },
  omp: { terminal: titleTerminal(), structured: unsupportedStructured },
  'prime-agent': { terminal: unsupportedTerminal, structured: unsupportedStructured },
  gemini: { terminal: titleTerminal(), structured: unsupportedStructured },
  // Captured screens are not sufficient to claim all startup/account/mode cases; keep this
  // provider explicitly unsupported until the missing evidence is recorded.
  antigravity: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  aider: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  goose: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  amp: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  kilo: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  kiro: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  crush: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  aug: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  cline: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  codebuff: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  'command-code': { terminal: unsupportedTerminal, structured: unsupportedStructured },
  continue: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  cursor: { terminal: screenTerminal(), structured: unsupportedStructured },
  droid: { terminal: titleTerminal(), structured: unsupportedStructured },
  kimi: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  'mistral-vibe': { terminal: unsupportedTerminal, structured: unsupportedStructured },
  'qwen-code': { terminal: unsupportedTerminal, structured: unsupportedStructured },
  rovo: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  hermes: { terminal: titleTerminal(), structured: unsupportedStructured },
  openclaw: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  copilot: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  grok: { terminal: unsupportedTerminal, structured: unsupportedStructured },
  devin: { terminal: titleTerminal(), structured: unsupportedStructured }
} satisfies Record<TuiAgent, AgentReadinessCapability>

export function getAgentReadinessCapability(
  agent: TuiAgent | null | undefined,
  path: keyof AgentReadinessCapability
): AgentLaunchPathCapability | null {
  return agent ? AGENT_READINESS_CAPABILITIES[agent][path] : null
}

export function supportsAgentPromptTurnStart(agent: TuiAgent | null | undefined): boolean {
  return getAgentReadinessCapability(agent, 'terminal')?.receipt === 'turn-start'
}
