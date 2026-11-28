import type { AgentType } from '../contracts/agent-status-types'

// Share agent names across desktop and mobile.
const WELL_KNOWN_LABELS: Record<string, string> = {
  claude: 'Claude',
  codebuddy: 'CodeBuddy',
  openclaude: 'OpenClaude',
  codex: 'Codex',
  qoder: 'Qoder CLI',
  qodercli: 'Qoder CLI',
  antigravity: 'Antigravity',
  amp: 'Amp',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  opencode2: 'OpenCode 2',
  'mimo-code': 'MiMo Code',
  kilo: 'Kilocode',
  cline: 'Cline',
  cursor: 'Cursor',
  aider: 'Aider',
  pi: 'Pi',
  omp: 'OMP',
  'prime-agent': 'Prime Agent',
  droid: 'Droid',
  'command-code': 'Command Code',
  grok: 'Grok',
  hermes: 'Hermes',
  goose: 'Goose',
  devin: 'Devin',
  ante: 'Ante',
  trae: 'Trae',
  kimi: 'Kimi',
  muse: 'Muse',
  zcode: 'ZCode',
  dsh: 'DeepSeek Harness',
  dsb: 'DeepSeek Build',
  jcode: 'Jcode',
  kiro: 'Kiro'
}

let configuredAgentLabel: (agentType: string) => string | null = () => null

/** Names agents a process learns at runtime (custom ACP agents from settings); one per process. */
export function setConfiguredAgentLabelSource(source: (agentType: string) => string | null): void {
  configuredAgentLabel = source
}

export function formatAgentTypeLabel(agentType: AgentType | null | undefined): string {
  if (!agentType || agentType === 'unknown') {
    return 'Agent'
  }
  // Capitalize well-known names nicely; pass through custom names as-is
  return WELL_KNOWN_LABELS[agentType] ?? configuredAgentLabel(agentType) ?? agentType
}
