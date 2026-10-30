import type { AgentType } from './agent-status-types'

// Share agent names across desktop and mobile.
const WELL_KNOWN_LABELS: Record<string, string> = {
  claude: 'Claude',
  codebuddy: 'CodeBuddy',
  openclaude: 'OpenClaude',
  codex: 'Codex',
  qoder: 'Qoder CLI',
  qodercli: 'Qoder CLI',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  amp: 'Amp',
  copilot: 'GitHub Copilot',
  opencode: 'OpenCode',
  opencode2: 'OpenCode 2',
  'mimo-code': 'MiMo Code',
  cursor: 'Cursor',
  aider: 'Aider',
  pi: 'Pi',
  omp: 'OMP',
  'prime-agent': 'Prime Agent',
  droid: 'Droid',
  'command-code': 'Command Code',
  grok: 'Grok',
  hermes: 'Hermes',
  devin: 'Devin',
  ante: 'Ante',
  trae: 'Trae',
  kimi: 'Kimi',
  muse: 'Muse',
  zcode: 'ZCode',
  dsh: 'DeepSeek Harness',
  dsb: 'DeepSeek Build',
  jcode: 'Jcode'
}

export function formatAgentTypeLabel(agentType: AgentType | null | undefined): string {
  if (!agentType || agentType === 'unknown') {
    return 'Agent'
  }
  // Capitalize well-known names nicely; pass through custom names as-is
  return WELL_KNOWN_LABELS[agentType] ?? agentType
}
